/**
 * Guards the generated OpenAPI document (#830).
 *
 * `swagger-jsdoc` silently *drops* a route file whose `@openapi` block fails
 * to parse — duplicate YAML keys, bad indentation — which is how the
 * commission docs went missing from `/api/docs` while the TypeScript still
 * compiled. These assertions fail loudly if a commission operation stops
 * being documented, a referenced schema disappears, or the status machine
 * stops being explained on the tag.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

import { openApiSpec } from '@/swagger';

interface Tag {
  readonly name: string;
  readonly description?: string;
}

type SecurityRequirement = Readonly<Record<string, readonly string[]>>;

const spec = openApiSpec as {
  readonly paths: Record<
    string,
    Record<string, { readonly security?: readonly SecurityRequirement[] }>
  >;
  readonly security: readonly SecurityRequirement[];
  readonly components: { readonly schemas: Record<string, unknown> };
  readonly tags: readonly Tag[];
};

const PROTECTED_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['/api/v1/auth/me', 'get'],
  ['/api/v1/users/me', 'patch'],
];

const PUBLIC_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['/api/v1/auth/login', 'post'],
  ['/api/v1/marketplace', 'get'],
];

/** Every commission operation the API actually serves. */
const COMMISSION_OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['/api/v1/commissions', 'post'],
  ['/api/v1/commissions/{id}', 'get'],
  ['/api/v1/commissions/{id}/status', 'patch'],
  ['/api/v1/commissions/{id}/disputes', 'post'],
  ['/api/v1/commissions/{id}/disputes/resolve', 'post'],
  ['/api/v1/admin/commissions/disputes', 'get'],
  ['/api/v1/users/me/commissions', 'get'],
];

const COMMISSION_SCHEMAS = [
  'Commission',
  'CommissionParty',
  'CommissionEvent',
  'CommissionTimelineEntry',
  'CommissionDetail',
  'CommissionDetailResponse',
  'CommissionResponse',
  'CommissionListItem',
  'CommissionListResponse',
  'CommissionReview',
  'CreateCommissionRequest',
  'Deliverable',
  'CommissionDispute',
  'CreateCommissionDisputeRequest',
  'CommissionDisputeResponse',
  'CommissionDisputeListResponse',
];

describe('OpenAPI document (#830)', () => {
  it('parses every @openapi block without duplicate YAML keys', () => {
    const routesDirectory = join(process.cwd(), 'src', 'routes');
    const routeFiles = readdirSync(routesDirectory).filter((file) => file.endsWith('.ts'));

    for (const file of routeFiles) {
      const source = readFileSync(join(routesDirectory, file), 'utf8');
      const blocks = [...source.matchAll(/@openapi\s*([\s\S]*?)\n\s*\*\//g)];

      for (const [index, block] of blocks.entries()) {
        const yaml = block[1]!
          .split('\n')
          .map((line) => line.replace(/^\s*\* ?/, ''))
          .join('\n');
        const document = parseDocument(yaml, { uniqueKeys: true });
        expect(document.errors, `${file} @openapi block ${index + 1}`).toEqual([]);
      }
    }
  });

  it.each(COMMISSION_OPERATIONS)('documents %s %s', (path, method) => {
    expect(spec.paths[path]?.[method]).toBeDefined();
  });

  it('uses opt-in authentication for operations', () => {
    expect(spec.security).toEqual([]);
  });

  it.each(PROTECTED_OPERATIONS)('requires bearer auth for %s %s', (path, method) => {
    expect(spec.paths[path]?.[method]?.security).toEqual([{ BearerAuth: [] }]);
  });

  it.each(PUBLIC_OPERATIONS)('keeps %s %s public', (path, method) => {
    const operation = spec.paths[path]?.[method];
    expect(operation).toBeDefined();
    expect(operation?.security ?? spec.security).toEqual([]);
  });

  it.each(COMMISSION_SCHEMAS)('exports the %s schema', (name) => {
    expect(spec.components.schemas[name]).toBeDefined();
  });

  it('explains the commission flow and status machine on the tag', () => {
    const commissions = spec.tags.find((tag) => tag.name === 'Commissions');
    expect(commissions?.description).toBeDefined();
    expect(commissions?.description).toContain('Status machine');
    for (const status of [
      'PENDING',
      'ACCEPTED',
      'IN_PROGRESS',
      'DELIVERED',
      'COMPLETED',
      'CANCELLED',
      'DISPUTED',
    ]) {
      expect(commissions?.description).toContain(status);
    }
  });

  it('documents error responses for the transition endpoint', () => {
    const status = spec.paths['/api/v1/commissions/{id}/status'] as {
      patch: {
        responses: Record<
          string,
          { content?: { 'application/json': { examples?: Record<string, unknown> } } }
        >;
      };
    };
    expect(status.patch.responses['409']).toBeDefined();
    expect(
      Object.keys(status.patch.responses['409']!.content!['application/json'].examples!),
    ).toEqual(expect.arrayContaining(['invalidTransition', 'notCancellable', 'escrowHeld']));
  });
});
