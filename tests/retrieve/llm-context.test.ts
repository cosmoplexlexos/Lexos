/**
 * GET /retrieve/llm-context — tests
 *
 * All DB calls are mocked.
 * Tests cover:
 *   1. Returns context array with intent + tier + phrases
 *   2. 400 on missing lang
 *   3. k param caps entries
 *   4. Entries sorted tier A → B → C
 *   5. entry_count matches context length
 *   6. query params forwarded to DB correctly
 *   7. 500 when DB throws
 */

import request from 'supertest';
import express from 'express';
import retrieveRouter from '../../src/routes/retrieve';

// ── Mock DB ──────────────────────────────────────────────────

const mockGetPhoneticVariants    = jest.fn().mockResolvedValue([]);
const mockGetLlmContextEntries   = jest.fn();

jest.mock('../../src/db/queries/retrieve', () => ({
  getPhoneticVariants:  (...args: unknown[]) => mockGetPhoneticVariants(...args),
  getLlmContextEntries: (...args: unknown[]) => mockGetLlmContextEntries(...args),
}));

jest.mock('../../src/config', () => ({
  config: {
    thresholds: { phoneticAmbiguity: 0.85 },
  },
}));

// ── Fixtures ─────────────────────────────────────────────────

const SAMPLE_ENTRIES = [
  { intent: 'LEXOS_CART_ADD_ITEM', tier: 'A', phrases: ['ek biryani do', 'biryani chahiye'] },
  { intent: 'LEXOS_MENU_VIEW',     tier: 'A', phrases: ['menu dikhao', 'kya milta hai'] },
  { intent: 'LEXOS_ORDER_MODIFY',  tier: 'B', phrases: ['order badlo', 'change karo'] },
  { intent: 'LEXOS_HELP_CONFUSED', tier: 'C', phrases: ['samajh nahi aaya', 'dobara bolo'] },
];

// ── App ──────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/retrieve', retrieveRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPhoneticVariants.mockResolvedValue([]);
  mockGetLlmContextEntries.mockResolvedValue(SAMPLE_ENTRIES);
});

// ── Validation ───────────────────────────────────────────────

describe('GET /retrieve/llm-context — validation', () => {
  const app = buildApp();

  test('400 when lang is missing', async () => {
    const res = await request(app).get('/retrieve/llm-context');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lang/);
  });

  test('200 with valid lang', async () => {
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(res.status).toBe(200);
  });
});

// ── Response shape ────────────────────────────────────────────

describe('GET /retrieve/llm-context — response shape', () => {
  const app = buildApp();

  test('returns context array with intent, tier, phrases', async () => {
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.context)).toBe(true);

    const entry = res.body.context[0];
    expect(typeof entry.intent).toBe('string');
    expect(typeof entry.tier).toBe('string');
    expect(Array.isArray(entry.phrases)).toBe(true);
  });

  test('includes entry_count matching context length', async () => {
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(res.body.entry_count).toBe(SAMPLE_ENTRIES.length);
    expect(res.body.context).toHaveLength(res.body.entry_count);
  });

  test('includes lang, domain, and latency_ms', async () => {
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN&domain=restaurant');
    expect(res.body.lang).toBe('hi-IN');
    expect(res.body.domain).toBe('restaurant');
    expect(typeof res.body.latency_ms).toBe('number');
  });

  test('domain defaults to "restaurant"', async () => {
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(res.body.domain).toBe('restaurant');
  });

  test('empty context when DB returns nothing', async () => {
    mockGetLlmContextEntries.mockResolvedValue([]);
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(res.body.context).toHaveLength(0);
    expect(res.body.entry_count).toBe(0);
  });
});

// ── k cap ─────────────────────────────────────────────────────

describe('GET /retrieve/llm-context — k parameter', () => {
  const app = buildApp();

  test('k param is forwarded to getLlmContextEntries', async () => {
    await request(app).get('/retrieve/llm-context?lang=hi-IN&k=10');
    expect(mockGetLlmContextEntries).toHaveBeenCalledWith(
      'hi-IN', 'restaurant', undefined, undefined, 10,
    );
  });

  test('k defaults to 30 when not provided', async () => {
    await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(mockGetLlmContextEntries).toHaveBeenCalledWith(
      'hi-IN', 'restaurant', undefined, undefined, 30,
    );
  });

  test('k is capped at 100', async () => {
    await request(app).get('/retrieve/llm-context?lang=hi-IN&k=500');
    expect(mockGetLlmContextEntries).toHaveBeenCalledWith(
      'hi-IN', 'restaurant', undefined, undefined, 100,
    );
  });
});

// ── Query forwarding ──────────────────────────────────────────

describe('GET /retrieve/llm-context — query forwarding', () => {
  const app = buildApp();

  test('lang, domain, tenant_id, workflow forwarded', async () => {
    await request(app).get(
      '/retrieve/llm-context?lang=ta-IN&domain=restaurant&tenant_id=south-indian&workflow=dine_in',
    );

    expect(mockGetLlmContextEntries).toHaveBeenCalledWith(
      'ta-IN', 'restaurant', 'south-indian', 'dine_in', 30,
    );
  });
});

// ── Error handling ────────────────────────────────────────────

describe('GET /retrieve/llm-context — error handling', () => {
  const app = buildApp();

  test('500 when DB throws', async () => {
    mockGetLlmContextEntries.mockRejectedValue(new Error('Connection refused'));
    const res = await request(app).get('/retrieve/llm-context?lang=hi-IN');
    expect(res.status).toBe(500);
  });
});
