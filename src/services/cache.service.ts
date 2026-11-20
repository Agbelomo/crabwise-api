/**
 * Generic Redis cache-aside helper, shared by every read-heavy endpoint
 * that needs caching (artwork listings, category lists, trending,
 * recommended, artist profiles).
 *
 * Degrades to calling `fetcher` directly (no caching, no error) when Redis
 * isn't configured — the same fallback convention as the rest of this
 * codebase's optional-Redis features.
 */

import { tryGetRedisClient } from './redis.service';

export interface CacheMetrics {
  hits: number;
  misses: number;
  /** Redis reads that failed (#125). Never counted as hits. */
  readErrors: number;
  /** Redis writes that failed or were not acknowledged (#125). */
  writeErrors: number;
}

const metrics = new Map<string, CacheMetrics>();

function metricsFor(namespace: string): CacheMetrics {
  let entry = metrics.get(namespace);
  if (entry === undefined) {
    entry = { hits: 0, misses: 0, readErrors: 0, writeErrors: 0 };
    metrics.set(namespace, entry);
  }
  return entry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Logs a Redis cache failure so it is visible rather than silently treated
 * as a hit or a successful write (#125). */
function reportCacheFailure(
  operation: 'read' | 'write' | 'delete',
  key: string,
  error: unknown,
): void {
  console.warn(`[cache] ${operation} failed for ${key}: ${errorMessage(error)}`);
}

/** Valid cache namespace: one or more `:`-separated segments of letters,
 * digits, `-` or `_` — never empty segments or Redis glob characters, which
 * would let one domain's pattern match another domain's keys (#126). */
const NAMESPACE_PATTERN = /^[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*$/;

function assertValidNamespace(namespace: string): void {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new Error(
      `Invalid cache namespace "${namespace}": use ":"-separated segments of letters, digits, "-" or "_" (#126)`,
    );
  }
}

/**
 * Builds a cache key `<namespace>:<part>:<part>...` in which every part is
 * URI-encoded, so a part containing `:` (or glob characters) can never forge
 * a key belonging to another namespace or another entry (#126).
 */
export function cacheKey(namespace: string, ...parts: ReadonlyArray<string | number>): string {
  assertValidNamespace(namespace);
  return [namespace, ...parts.map((part) => encodeURIComponent(String(part)))].join(':');
}

/** Hit/miss counters recorded so far, per cache namespace. Read by a
 * metrics/health endpoint or logged periodically — see `logCacheMetrics`. */
export function getCacheMetrics(): ReadonlyMap<string, Readonly<CacheMetrics>> {
  return metrics;
}

/** Logs current hit rates per namespace (console — this codebase has no
 * dedicated structured logger). Call periodically (e.g. from a scheduled
 * job) or on demand; it's side-effect-free otherwise. */
export function logCacheMetrics(): void {
  for (const [namespace, { hits, misses, readErrors, writeErrors }] of metrics) {
    const total = hits + misses;
    const hitRate = total === 0 ? 0 : Math.round((hits / total) * 100);
    console.log(
      `[cache] ${namespace}: ${hits} hits, ${misses} misses (${hitRate}% hit rate), ` +
        `${readErrors} read errors, ${writeErrors} write errors`,
    );
  }
}

function namespaceOf(key: string): string {
  return key.split(':')[0] ?? key;
}

/** On-disk cache envelope so TTL can be enforced even when Redis is mocked
 * or a key somehow outlives its EX (#124). */
interface CacheEnvelope<T> {
  readonly v: T;
  /** Absolute expiry time in epoch milliseconds. */
  readonly exp: number;
  /** Data domain that wrote this entry (#126). A reader asking for a
   * different domain treats the entry as a miss instead of serving it. */
  readonly d?: string;
}

export interface CachedOptions {
  /**
   * Data domain of the cached value (e.g. `search-results`, `sorted-results`).
   * Defaults to the key's namespace. Two call sites caching different data
   * types under the same key string never serve each other's values (#126).
   */
  readonly domain?: string;
}

function isEnvelope(value: unknown): value is CacheEnvelope<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'v' in value &&
    'exp' in value &&
    typeof (value as CacheEnvelope<unknown>).exp === 'number'
  );
}

/**
 * Cache-aside read: serve `key` from Redis if present **and not expired**,
 * otherwise call `fetcher`, cache its result for `ttlSeconds`, and return it.
 *
 * Expired entries (past `exp`) are treated as misses, deleted, and refreshed
 * (#124), independent of Redis key eviction.
 *
 * Redis failures never masquerade as hits (#125): a failed or malformed read
 * is counted in `readErrors`, logged, and falls through to `fetcher`; a failed
 * or unacknowledged write is counted in `writeErrors` and logged, and the
 * freshly fetched value is still returned. Errors thrown by `fetcher` itself
 * propagate unchanged.
 *
 * Entries written for another data domain are never served (#126).
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options: CachedOptions = {},
): Promise<T> {
  const redis = tryGetRedisClient();
  if (redis === undefined) {
    return fetcher();
  }

  const namespace = namespaceOf(key);
  const domain = options.domain ?? namespace;
  const counters = metricsFor(namespace);

  let hit: unknown = null;
  try {
    hit = await redis.get(key);
  } catch (error) {
    counters.readErrors += 1;
    reportCacheFailure('read', key, error);
  }

  if (hit !== null && typeof hit !== 'string') {
    // A client returning something other than a string/null is a broken
    // read, not a hit (#125).
    counters.readErrors += 1;
    reportCacheFailure('read', key, new Error(`unexpected reply type ${typeof hit}`));
  } else if (typeof hit === 'string') {
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(hit);
    } catch (error) {
      parseFailed = true;
      counters.readErrors += 1;
      reportCacheFailure('read', key, error);
    }

    if (!parseFailed) {
      if (isEnvelope(parsed)) {
        const sameDomain = parsed.d === undefined || parsed.d === domain;
        if (sameDomain && Date.now() < parsed.exp) {
          counters.hits += 1;
          return parsed.v as T;
        }
        // Expired (#124) or written by another domain (#126): a miss.
      } else if (options.domain === undefined) {
        // Legacy bare value (pre-envelope): honor Redis presence only.
        counters.hits += 1;
        return parsed as T;
      }
    }
    await safeDelete(redis, key);
  }

  counters.misses += 1;
  const value = await fetcher();
  const envelope: CacheEnvelope<T> = {
    v: value,
    exp: Date.now() + ttlSeconds * 1000,
    d: domain,
  };
  try {
    const reply: unknown = await redis.set(key, JSON.stringify(envelope), 'EX', ttlSeconds);
    if (reply !== 'OK') {
      counters.writeErrors += 1;
      reportCacheFailure('write', key, new Error(`unexpected reply ${String(reply)}`));
    }
  } catch (error) {
    counters.writeErrors += 1;
    reportCacheFailure('write', key, error);
  }
  return value;
}

/** Best-effort delete of a stale/corrupt entry; failures are logged, not thrown. */
async function safeDelete(
  redis: NonNullable<ReturnType<typeof tryGetRedisClient>>,
  key: string,
): Promise<void> {
  try {
    await redis.del(key);
  } catch (error) {
    reportCacheFailure('delete', key, error);
  }
}

/**
 * Deletes specific cache keys (as opposed to a whole namespace). No-op when
 * Redis isn't configured — same degradation as `cached`/`invalidateNamespace`.
 */
export async function invalidateKeys(...keys: string[]): Promise<void> {
  const redis = tryGetRedisClient();
  if (redis === undefined || keys.length === 0) {
    return;
  }
  await redis.del(...keys);
}

/** How many keys `invalidateNamespace` buffers per `DEL` pipeline batch.
 * Keeps memory bounded on large namespaces while still round-tripping far
 * fewer times than deleting keys one by one (#866). */
const INVALIDATE_BATCH_SIZE = 500;

/** `SCAN` cursor used to start/continue an iteration; `0` means "done". */
const SCAN_CURSOR_START = '0';

/**
 * Invalidates every cached key under `namespace` (keys are always written
 * as `<namespace>:...`). Called after mutations that would otherwise leave
 * a cached read stale until its TTL expires — see `saves.service` and
 * `trending.service` for callers.
 *
 * Iterates with cursor-based `SCAN` (never the O(N) blocking `KEYS`
 * command) and deletes matched keys in pipelined `DEL` batches of
 * `INVALIDATE_BATCH_SIZE`, so invalidation stays safe on production
 * keyspaces of any size without blocking Redis (#866).
 */
export async function invalidateNamespace(namespace: string): Promise<void> {
  // #126 — an empty or wildcard namespace (`''`, `*`, `mark*`) would match
  // and delete keys belonging to other cache domains.
  assertValidNamespace(namespace);
  const redis = tryGetRedisClient();
  if (redis === undefined) {
    return;
  }

  const pattern = `${namespace}:*`;
  let cursor = SCAN_CURSOR_START;
  let batch: string[] = [];

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      INVALIDATE_BATCH_SIZE,
    );
    cursor = nextCursor;
    batch.push(...keys);

    if (batch.length >= INVALIDATE_BATCH_SIZE) {
      await redis.del(...batch);
      batch = [];
    }
  } while (cursor !== SCAN_CURSOR_START);

  if (batch.length > 0) {
    await redis.del(...batch);
  }
}
