/**
 * POST /enrich — semantic search tests (Step 4)
 *
 * All DB calls and external adapters are mocked.
 * Tests cover:
 *   1. Novel phrase (no exact match) resolves via semantic → match_type: 'semantic'
 *   2. Gibberish phrase resolves to nothing → match_type: 'miss'
 *   3. Miss is logged to lexos_misses (fire-and-forget)
 *   4. Semantic path is skipped (graceful degrade) when Cloudflare throws
 *   5. generateEmbedding is called with the trimmed phrase
 *   6. semanticMatch receives the generated embedding + lang + domain + tenant
 */

import request from 'supertest';
import express from 'express';
import enrichRouter from '../../src/routes/enrich';

// ── Mocks ────────────────────────────────────────────────────

const mockExactMatch    = jest.fn();
const mockLogEnrichCall = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/db/queries/enrich', () => ({
  exactMatch:    (...args: unknown[]) => mockExactMatch(...args),
  logEnrichCall: (...args: unknown[]) => mockLogEnrichCall(...args),
}));

const mockSemanticMatch = jest.fn();
const mockLogMiss       = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/db/queries/semantic', () => ({
  semanticMatch: (...args: unknown[]) => mockSemanticMatch(...args),
  logMiss:       (...args: unknown[]) => mockLogMiss(...args),
}));

const FAKE_EMBEDDING = new Array(768).fill(0.05);
const mockGenerateEmbedding = jest.fn().mockResolvedValue(FAKE_EMBEDDING);

jest.mock('../../src/adapters/cloudflare-ai', () => ({
  generateEmbedding:       (...args: unknown[]) => mockGenerateEmbedding(...args),
  generateEmbeddingsBatch: jest.fn(),
  EMBED_MODEL_NAME:        '@cf/baai/bge-base-en-v1.5',
  EMBED_MODEL_VERSION:     '1.0',
}));

jest.mock('../../src/config', () => ({
  config: {
    langsmith: { enabled: false },
    thresholds: {
      intentMatch: 0.75,
    },
    cloudflare: {
      accountId:  'test-account',
      apiToken:   'test-token',
      embedModel: '@cf/baai/bge-base-en-v1.5',
    },
  },
}));

// ── Fixtures ─────────────────────────────────────────────────

const SEMANTIC_HIT = {
  intent:     'LEXOS_CART_ADD_ITEM',
  confidence: 0.88,
  term_id:    'uuid-term-001',
};

// ── App setup ────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/enrich', enrichRouter);
  return app;
}

// ── Setup / teardown ─────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: exact match always misses — semantic tests exercise the fallback
  mockExactMatch.mockResolvedValue(null);
  mockLogEnrichCall.mockResolvedValue(undefined);
  mockLogMiss.mockResolvedValue(undefined);
  mockGenerateEmbedding.mockResolvedValue(FAKE_EMBEDDING);
});

// ── Tests ─────────────────────────────────────────────────────

describe('POST /enrich — semantic resolution', () => {
  const app = buildApp();

  test('novel phrase resolves via semantic when exact match fails', async () => {
    mockSemanticMatch.mockResolvedValue(SEMANTIC_HIT);

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'I would like to order some food', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent:     'LEXOS_CART_ADD_ITEM',
      confidence: 0.88,
      match_type: 'semantic',
    });
    // matched_head is null for semantic (no exact variant matched)
    expect(res.body.matched_head).toBeNull();
    expect(typeof res.body.latency_ms).toBe('number');
  });

  test('gibberish phrase returns miss when both exact and semantic fail', async () => {
    mockSemanticMatch.mockResolvedValue(null);

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'xyzzy quux florp blarg', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      intent:     null,
      confidence: 0,
      match_type: 'miss',
    });
  });

  test('generateEmbedding is called with the trimmed phrase', async () => {
    mockSemanticMatch.mockResolvedValue(null);

    await request(app)
      .post('/enrich')
      .send({ phrase: '  kuch khana chahiye  ', lang: 'hi-IN' });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith('kuch khana chahiye');
  });

  test('semanticMatch receives embedding, lang, domain, and tenant', async () => {
    mockSemanticMatch.mockResolvedValue(SEMANTIC_HIT);

    await request(app)
      .post('/enrich')
      .send({
        phrase:    'order something for me',
        lang:      'ta-IN',
        domain:    'restaurant',
        tenant_id: 'south-indian',
      });

    expect(mockSemanticMatch).toHaveBeenCalledWith(
      FAKE_EMBEDDING,
      'ta-IN',
      'restaurant',
      'south-indian',
    );
  });
});

describe('POST /enrich — miss logging', () => {
  const app = buildApp();

  test('logMiss is called on miss (fire-and-forget)', async () => {
    mockSemanticMatch.mockResolvedValue(null);

    await request(app)
      .post('/enrich')
      .send({
        phrase:    'complete nonsense',
        lang:      'hi-IN',
        workflow:  'order_flow',
        tenant_id: 'north-indian',
      });

    // Give fire-and-forget a tick
    await new Promise(resolve => setImmediate(resolve));

    expect(mockLogMiss).toHaveBeenCalledTimes(1);
    const arg = mockLogMiss.mock.calls[0][0];
    expect(arg.utterance).toBe('complete nonsense');
    expect(arg.lang).toBe('hi-IN');
    expect(arg.workflow).toBe('order_flow');
    expect(arg.tenant_id).toBe('north-indian');
  });

  test('logMiss is NOT called when intent resolves (exact)', async () => {
    mockExactMatch.mockResolvedValue({
      intent:       'LEXOS_MENU_VIEW',
      confidence:   0.95,
      matched_head: 'menu dikhao',
      variant_type: 'COLLOQUIAL',
    });

    await request(app)
      .post('/enrich')
      .send({ phrase: 'menu dikhao', lang: 'hi-IN' });

    await new Promise(resolve => setImmediate(resolve));

    expect(mockLogMiss).not.toHaveBeenCalled();
  });

  test('logMiss is NOT called when intent resolves (semantic)', async () => {
    mockSemanticMatch.mockResolvedValue(SEMANTIC_HIT);

    await request(app)
      .post('/enrich')
      .send({ phrase: 'something food-related', lang: 'hi-IN' });

    await new Promise(resolve => setImmediate(resolve));

    expect(mockLogMiss).not.toHaveBeenCalled();
  });

  test('logMiss failure does not affect response', async () => {
    mockSemanticMatch.mockResolvedValue(null);
    mockLogMiss.mockRejectedValue(new Error('DB timeout'));

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'complete nonsense', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body.match_type).toBe('miss');
  });
});

describe('POST /enrich — Cloudflare graceful degrade', () => {
  const app = buildApp();

  test('falls to miss (not 500) when Cloudflare embedding fails', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('Cloudflare credentials not configured'));

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'some unknown phrase', lang: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body.match_type).toBe('miss');
    // semanticMatch should never be called if embedding failed
    expect(mockSemanticMatch).not.toHaveBeenCalled();
  });

  test('falls to miss when Cloudflare returns HTTP error', async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error('Cloudflare AI HTTP 429: Rate limited'));

    const res = await request(app)
      .post('/enrich')
      .send({ phrase: 'some phrase', lang: 'es-ES' });

    expect(res.status).toBe(200);
    expect(res.body.match_type).toBe('miss');
  });
});
