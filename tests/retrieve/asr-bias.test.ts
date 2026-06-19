/**
 * GET /retrieve/asr-bias — tests
 *
 * All DB calls are mocked. Tests cover:
 *   1. Whisper adapter — returns initial_prompt string
 *   2. Deepgram Nova-3 adapter — returns filtered keywords array
 *   3. Sarvam adapter — returns vocabulary_hints array
 *   4. PHONETIC_AMBIGUITY_THRESHOLD filter on Deepgram
 *   5. Max 100 keyword cap on Deepgram
 *   6. 400 on missing lang
 *   7. 400 on unsupported asr param
 *   8. Response shape includes term_count and latency_ms
 *   9. workflow param forwarded to DB query
 */

import request from 'supertest';
import express from 'express';
import retrieveRouter from '../../src/routes/retrieve';

// ── Mock DB ──────────────────────────────────────────────────

const mockGetPhoneticVariants = jest.fn();

jest.mock('../../src/db/queries/retrieve', () => ({
  getPhoneticVariants: (...args: unknown[]) => mockGetPhoneticVariants(...args),
}));

jest.mock('../../src/config', () => ({
  config: {
    thresholds: {
      phoneticAmbiguity: 0.85,
    },
  },
}));

// ── Fixtures ─────────────────────────────────────────────────

function makeVariants(n: number, confidence = 0.92) {
  return Array.from({ length: n }, (_, i) => ({
    value:       `phrase ${i}`,
    confidence,
    intent_name: `LEXOS_INTENT_${i}`,
    tenant_id:   null,
  }));
}

const HINDI_VARIANTS = [
  { value: 'menu dikhao',    confidence: 0.94, intent_name: 'LEXOS_MENU_VIEW',    tenant_id: null },
  { value: 'ek biryani do',  confidence: 0.91, intent_name: 'LEXOS_CART_ADD_ITEM', tenant_id: null },
  { value: 'bill le aao',    confidence: 0.87, intent_name: 'LEXOS_BILL_REQUEST',  tenant_id: null },
  { value: 'kuch nahi',      confidence: 0.78, intent_name: 'LEXOS_CANCEL',        tenant_id: null },
];

// ── App ──────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/retrieve', retrieveRouter);
  return app;
}

// ── Setup ─────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPhoneticVariants.mockResolvedValue(HINDI_VARIANTS);
});

// ── Validation ───────────────────────────────────────────────

describe('GET /retrieve/asr-bias — validation', () => {
  const app = buildApp();

  test('400 when lang is missing', async () => {
    const res = await request(app).get('/retrieve/asr-bias?asr=whisper');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lang/);
  });

  test('400 when asr is missing', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asr/);
  });

  test('400 when asr is unsupported', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=unknown-engine');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asr/);
  });

  test('200 for each supported asr value', async () => {
    const app2 = buildApp();
    for (const asr of ['whisper', 'deepgram-nova3', 'sarvam']) {
      const res = await request(app2).get(`/retrieve/asr-bias?lang=hi-IN&asr=${asr}`);
      expect(res.status).toBe(200);
    }
  });
});

// ── Whisper adapter ──────────────────────────────────────────

describe('GET /retrieve/asr-bias — whisper', () => {
  const app = buildApp();

  test('returns initial_prompt string', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');

    expect(res.status).toBe(200);
    expect(res.body.asr).toBe('whisper');
    expect(typeof res.body.payload.initial_prompt).toBe('string');
    expect(res.body.payload.initial_prompt.length).toBeGreaterThan(0);
  });

  test('initial_prompt contains language context', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');
    expect(res.body.payload.initial_prompt).toContain('Hindi');
  });

  test('initial_prompt contains phonetic phrase values', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');
    expect(res.body.payload.initial_prompt).toContain('menu dikhao');
  });

  test('initial_prompt stays under 200 tokens (word-count proxy)', async () => {
    // Provide 200 variants to test the cap
    const manyVariants = Array.from({ length: 200 }, (_, i) => ({
      value:       `ordering phrase number ${i}`,
      confidence:  0.9,
      intent_name: `LEXOS_INTENT_${i}`,
      tenant_id:   null,
    }));
    mockGetPhoneticVariants.mockResolvedValue(manyVariants);

    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');
    const wordCount = res.body.payload.initial_prompt.split(' ').length;
    expect(wordCount).toBeLessThan(160);  // ≈200 tokens
  });

  test('falls back gracefully for unrecognised language code', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=xx-XX&asr=whisper');
    expect(res.status).toBe(200);
    expect(typeof res.body.payload.initial_prompt).toBe('string');
  });
});

// ── Deepgram Nova-3 adapter ──────────────────────────────────

describe('GET /retrieve/asr-bias — deepgram-nova3', () => {
  const app = buildApp();

  test('returns keywords array', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=deepgram-nova3');

    expect(res.status).toBe(200);
    expect(res.body.asr).toBe('deepgram-nova3');
    expect(Array.isArray(res.body.payload.keywords)).toBe(true);
  });

  test('PHONETIC_AMBIGUITY_THRESHOLD (0.85) filters out low-confidence variants', async () => {
    // HINDI_VARIANTS has one variant with confidence 0.78 < 0.85 → should be excluded
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=deepgram-nova3');

    expect(res.body.payload.keywords).not.toContain('kuch nahi');  // 0.78 < 0.85
    expect(res.body.payload.keywords).toContain('menu dikhao');    // 0.94 ≥ 0.85
    expect(res.body.payload.keywords).toContain('ek biryani do');  // 0.91 ≥ 0.85
    expect(res.body.payload.keywords).toContain('bill le aao');    // 0.87 ≥ 0.85
  });

  test('keywords are sorted by confidence descending', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=deepgram-nova3');
    const keywords: string[] = res.body.payload.keywords;

    // menu dikhao (0.94) must come before ek biryani do (0.91)
    const menuIdx    = keywords.indexOf('menu dikhao');
    const biryaniIdx = keywords.indexOf('ek biryani do');
    expect(menuIdx).toBeLessThan(biryaniIdx);
  });

  test('keyword count never exceeds 100', async () => {
    mockGetPhoneticVariants.mockResolvedValue(makeVariants(150, 0.95));

    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=deepgram-nova3');
    expect(res.body.payload.keywords.length).toBeLessThanOrEqual(100);
  });

  test('empty keyword list when all variants are below threshold', async () => {
    mockGetPhoneticVariants.mockResolvedValue(makeVariants(10, 0.70));

    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=deepgram-nova3');
    expect(res.body.payload.keywords).toHaveLength(0);
  });
});

// ── Sarvam adapter ───────────────────────────────────────────

describe('GET /retrieve/asr-bias — sarvam', () => {
  const app = buildApp();

  test('returns vocabulary_hints array', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=sarvam');

    expect(res.status).toBe(200);
    expect(res.body.asr).toBe('sarvam');
    expect(Array.isArray(res.body.payload.vocabulary_hints)).toBe(true);
  });

  test('each hint has a word field', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=sarvam');
    const hints: { word: string }[] = res.body.payload.vocabulary_hints;

    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(typeof hint.word).toBe('string');
      expect(hint.word.length).toBeGreaterThan(0);
    }
  });

  test('all variant values appear as hint words', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=sarvam');
    const words = (res.body.payload.vocabulary_hints as { word: string }[]).map(h => h.word);

    for (const v of HINDI_VARIANTS) {
      expect(words).toContain(v.value);
    }
  });
});

// ── Common response shape ─────────────────────────────────────

describe('GET /retrieve/asr-bias — response shape', () => {
  const app = buildApp();

  test('response always includes term_count and latency_ms', async () => {
    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');

    expect(typeof res.body.term_count).toBe('number');
    expect(res.body.term_count).toBe(HINDI_VARIANTS.length);
    expect(typeof res.body.latency_ms).toBe('number');
    expect(res.body.latency_ms).toBeGreaterThanOrEqual(0);
  });

  test('term_count is 0 when no variants exist', async () => {
    mockGetPhoneticVariants.mockResolvedValue([]);

    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');
    expect(res.body.term_count).toBe(0);
  });
});

// ── DB query forwarding ──────────────────────────────────────

describe('GET /retrieve/asr-bias — query param forwarding', () => {
  const app = buildApp();

  test('lang, domain, tenant_id, and workflow are forwarded to getPhoneticVariants', async () => {
    await request(app).get(
      '/retrieve/asr-bias?lang=ta-IN&asr=whisper&domain=restaurant&tenant_id=south-indian&workflow=dine_in',
    );

    expect(mockGetPhoneticVariants).toHaveBeenCalledWith(
      'ta-IN',
      'restaurant',
      'south-indian',
      'dine_in',
    );
  });

  test('domain defaults to "restaurant" when not provided', async () => {
    await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');

    expect(mockGetPhoneticVariants).toHaveBeenCalledWith(
      'hi-IN',
      'restaurant',
      undefined,
      undefined,
    );
  });

  test('500 when DB throws', async () => {
    mockGetPhoneticVariants.mockRejectedValue(new Error('Connection refused'));

    const res = await request(app).get('/retrieve/asr-bias?lang=hi-IN&asr=whisper');
    expect(res.status).toBe(500);
  });
});
