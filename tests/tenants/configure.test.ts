/**
 * Tenant profile configuration tests
 *
 * Tests:
 *   POST /tenants/:id/configure
 *     1. Creates tenant profile with all fields
 *     2. Updates existing tenant (upsert)
 *     3. Rejects invalid register_preference
 *     4. Rejects invalid tenant_type
 *     5. 500 on DB error
 *
 *   POST /tenants/:id/vocabulary
 *     6. Adds items to seed vocabulary
 *     7. Rejects empty items array
 *     8. Rejects non-array items
 *     9. 500 on DB error
 */

import request from 'supertest';
import app from '../../src/app';

// ── Mock DB ──────────────────────────────────────────────────

const mockUpsertTenantProfile   = jest.fn();
const mockMergeTenantVocabulary = jest.fn();
const mockGetTenantProfile      = jest.fn();

jest.mock('../../src/db/queries/tenants', () => ({
  upsertTenantProfile:   (...a: unknown[]) => mockUpsertTenantProfile(...a),
  mergeTenantVocabulary: (...a: unknown[]) => mockMergeTenantVocabulary(...a),
  getTenantProfile:      (...a: unknown[]) => mockGetTenantProfile(...a),
}));

// ── Fixtures ─────────────────────────────────────────────────

const TENANT_PROFILE = {
  tenant_id:           'demo-south-indian',
  tenant_type:         'business',
  primary_language:    'ta-IN',
  geographic_region:   'Chennai',
  register_preference: 'colloquial',
  customer_demographic: null,
  seed_vocabulary:     { items: ['idli', 'dosa', 'filter kaapi'] },
  configured_at:       '2026-06-12T00:00:00Z',
  last_updated:        '2026-06-12T00:00:00Z',
};

// ── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockUpsertTenantProfile.mockResolvedValue(TENANT_PROFILE);
  mockMergeTenantVocabulary.mockResolvedValue(undefined);
  mockGetTenantProfile.mockResolvedValue({
    ...TENANT_PROFILE,
    seed_vocabulary: { items: ['idli', 'dosa', 'filter kaapi', 'vada'] },
  });
});

// ── POST /tenants/:id/configure ───────────────────────────────

describe('POST /tenants/:id/configure', () => {
  test('creates profile and returns it', async () => {
    const res = await request(app)
      .post('/tenants/demo-south-indian/configure')
      .send({
        tenant_type:         'business',
        primary_language:    'ta-IN',
        geographic_region:   'Chennai',
        register_preference: 'colloquial',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('demo-south-indian');
    expect(res.body.profile).toBeDefined();
  });

  test('calls upsertTenantProfile with all provided fields', async () => {
    await request(app)
      .post('/tenants/demo-tenant/configure')
      .send({
        primary_language:    'hi-IN',
        register_preference: 'mixed',
      });

    expect(mockUpsertTenantProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id:           'demo-tenant',
        primary_language:    'hi-IN',
        register_preference: 'mixed',
      }),
    );
  });

  test('rejects invalid register_preference', async () => {
    const res = await request(app)
      .post('/tenants/demo/configure')
      .send({ register_preference: 'casual' });

    expect(res.status).toBe(400);
    expect(mockUpsertTenantProfile).not.toHaveBeenCalled();
  });

  test('rejects invalid tenant_type', async () => {
    const res = await request(app)
      .post('/tenants/demo/configure')
      .send({ tenant_type: 'enterprise' });

    expect(res.status).toBe(400);
  });

  test('returns 500 on DB error', async () => {
    mockUpsertTenantProfile.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .post('/tenants/demo/configure')
      .send({ primary_language: 'hi-IN' });

    expect(res.status).toBe(500);
  });
});

// ── POST /tenants/:id/vocabulary ──────────────────────────────

describe('POST /tenants/:id/vocabulary', () => {
  test('adds vocabulary items and returns total count', async () => {
    const res = await request(app)
      .post('/tenants/demo-south-indian/vocabulary')
      .send({ items: ['vada', 'sambhar'] });

    expect(res.status).toBe(200);
    expect(res.body.tenant_id).toBe('demo-south-indian');
    expect(res.body.added).toBe(2);
    expect(typeof res.body.total_vocabulary).toBe('number');
  });

  test('rejects empty items array', async () => {
    const res = await request(app)
      .post('/tenants/demo/vocabulary')
      .send({ items: [] });

    expect(res.status).toBe(400);
    expect(mockMergeTenantVocabulary).not.toHaveBeenCalled();
  });

  test('rejects non-array items', async () => {
    const res = await request(app)
      .post('/tenants/demo/vocabulary')
      .send({ items: 'idli dosa' });

    expect(res.status).toBe(400);
  });

  test('returns 500 on DB error', async () => {
    mockMergeTenantVocabulary.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .post('/tenants/demo/vocabulary')
      .send({ items: ['vada'] });

    expect(res.status).toBe(500);
  });
});
