/**
 * POST /enrich — exact match tests
 *
 * All DB calls and external adapters are mocked — no real DB or API access needed.
 * Tests cover:
 *   1. Known phrase → resolved intent (match_type: 'exact')
 *   2. Unknown phrase → null intent (match_type: 'miss')
 *   3. logEnrichCall is invoked on every request
 *   4. 400 on missing phrase
 *   5. 400 on missing lang
 *   6. Tenant-layered result prefers tenant-specific match
 *
 * Semantic path is mocked to return null by default so all
 * "unknown phrase → miss" cases still pass after Step 4.
 */

import request from 'supertest';
import express from 'express';
import enrichRouter from '../../src/routes/enrich';

// ── Mock DB queries ─────────────────────────────────────────

const mockExactMatch    = jest.fn();
const mockLogEnrichCall = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/db/queries/enrich', () => ({
  exactMatch:    (...args: unknown[]) => mockExactMatch(...args),
  logEnrichCall: (...args: unknown[]) => mockLogEnrichCall(...args),
}));

// Semantic path mocked to miss by default — tested separately in enrich-semantic.test.ts
const mockSemanticMatch = jest.fn().mockResolvedValue(null);
const mockLogMiss       = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/db/queries/semantic', () => ({
  semanticMatch: (...args: unknown[]) => mockSemanticMatch(...args),
  logMiss:       (...args: unknown[]) => mockLogMiss(...args),
}));

// Cloudflare adapter — returns a fake embedding so semantic path doesn't throw
const mockGenerateEmbedding = jest.fn().mockResolvedValue(new Array(768).fill(0.1));

jest.mock('../../src/adapters/cloudflare-ai', () => ({
  generateEmbedding:       (...args: unknown[]) => mockGenerateEmbedding(...args),
  generateEmbeddingsBatch: jest.fn(),
  EMBED_MODEL_NAME:        '@cf/baai/bge-base-en-v1.5',
  EMBED_MODEL_VERSION:     '1.0',
}));

// ── Mock config (so no real env vars needed) ────────────────

jest.mock('../../src/config', () => ({
  config: {
    langsmith: { enabled: false },
    thresholds: {
      intentMatch: 0.75,
    },
  },
}));

// ── Build a minimal Express app for testing ─────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/enrich', enrichRouter);
  return app;
}

// ── Fixtures ────────────────────────────────────────────────

const KNOWN_MATCH = {
  intent:       'LEXOS_CART_ADD_ITEM',
  confidence:   0.92,
  matched_head: 'ek biryani dena',
  variant_type: 'COLLOQUIAL',
};

// ── Tests ────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockLogEnrichCall.mockResolvedValue(undefined);
  mockLogMiss.mockResolvedValue(undefined);
  // Semantic defaults to no-match — exact match tests don't need it
  mockSemanticMatch.mockResolvedValue(null);
  mockGenerateEmbedding.mockResolvedValue(new Array(768).fill(0.1));
});

describe('POST /enrich — validation', () => {
  const app = buildApp();

  test('400 when phrase is missing', async () => {
    const res = await request(app)
      .post('/enrich')
      .send({ lang: 'hi-IN' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phrase/);
  });

  test('400 when phrase is empty string', async () => {
    const res = await request(app)
      .post('/enrich')
      .send({ phrase: '   ', lang: 'hi-IN' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/phrase/);
  });

  test('400 when lang is missing', async () => {
    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lang/);
  });

  test('400 when lang is empty string', async () => {
    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: '' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lang/);
  });
});

describe('POST /enrich — exact match resolution', () => {
  const app = buildApp();

  test('known phrase resolves to intent with match_type: exact', async () => {
    mockExactMatch.mockResolvedValue(KNOWN_MATCH);

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent:       'LEXOS_CART_ADD_ITEM',
      confidence:   0.92,
      matched_head: 'ek biryani dena',
      match_type:   'exact',
    });
    expect(typeof res.body.latency_ms).toBe('number');
    expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('unknown phrase returns null intent with match_type: miss', async () => {
    mockExactMatch.mockResolvedValue(null);

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'utter nonsense phrase xyz', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent:       null,
      confidence:   0,
      matched_head: null,
      match_type:   'miss',
    });
    expect(typeof res.body.latency_ms).toBe('number');
  });

  test('exactMatch is called with correct phrase and lang', async () => {
    mockExactMatch.mockResolvedValue(null);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'menu dikhao', lang: 'hi-IN', domain: 'restaurant' });

    expect(mockExactMatch).toHaveBeenCalledWith(
      'menu dikhao',
      'hi-IN',
      'restaurant',
      undefined,
    );
  });

  test('default domain is "restaurant" when not provided', async () => {
    mockExactMatch.mockResolvedValue(null);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'menu dikhao', lang: 'hi-IN' });

    expect(mockExactMatch).toHaveBeenCalledWith(
      'menu dikhao',
      'hi-IN',
      'restaurant',
      undefined,
    );
  });

  test('tenant_id is forwarded to exactMatch', async () => {
    mockExactMatch.mockResolvedValue(KNOWN_MATCH);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: 'hi-IN', tenant_id: 'south-indian' });

    expect(mockExactMatch).toHaveBeenCalledWith(
      'ek biryani dena',
      'hi-IN',
      'restaurant',
      'south-indian',
    );
  });
});

describe('POST /enrich — logging', () => {
  const app = buildApp();

  test('logEnrichCall is called on every request (match)', async () => {
    mockExactMatch.mockResolvedValue(KNOWN_MATCH);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: 'hi-IN', tenant_id: 'my-tenant' });

    // Give fire-and-forget a tick to complete
    await new Promise(resolve => setImmediate(resolve));

    expect(mockLogEnrichCall).toHaveBeenCalledTimes(1);
    const logArg = mockLogEnrichCall.mock.calls[0][0];
    expect(logArg.input_phrase).toBe('ek biryani dena');
    expect(logArg.matched_intent).toBe('LEXOS_CART_ADD_ITEM');
    expect(logArg.match_type).toBe('exact');
    expect(logArg.lang).toBe('hi-IN');
    expect(logArg.tenant_id).toBe('my-tenant');
  });

  test('logEnrichCall is called on every request (miss)', async () => {
    mockExactMatch.mockResolvedValue(null);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'nonsense phrase', lang: 'ta-IN' });

    await new Promise(resolve => setImmediate(resolve));

    expect(mockLogEnrichCall).toHaveBeenCalledTimes(1);
    const logArg = mockLogEnrichCall.mock.calls[0][0];
    expect(logArg.input_phrase).toBe('nonsense phrase');
    expect(logArg.matched_intent).toBeNull();
    expect(logArg.match_type).toBe('miss');
    expect(logArg.lang).toBe('ta-IN');
  });

  test('logEnrichCall failure does not affect response', async () => {
    mockExactMatch.mockResolvedValue(KNOWN_MATCH);
    mockLogEnrichCall.mockRejectedValue(new Error('DB connection lost'));

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: 'hi-IN' });

    // Response must still succeed even if logging throws
    expect(res.status).toBe(200);
    expect(res.body.match_type).toBe('exact');
  });
});

describe('POST /enrich — error handling', () => {
  const app = buildApp();

  test('500 when DB throws', async () => {
    mockExactMatch.mockRejectedValue(new Error('Connection refused'));

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'ek biryani dena', lang: 'hi-IN' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });
});
