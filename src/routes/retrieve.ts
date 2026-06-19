import { Router, Request, Response } from 'express';
import { config } from '../config';
import { getPhoneticVariants, getLlmContextEntries } from '../db/queries/retrieve';
import { getDistinctMenuNames } from '../db/queries/menu';
import { formatWhisperPayload,  WhisperPayload }  from '../adapters/asr/whisper';
import { formatDeepgramPayload, DeepgramPayload } from '../adapters/asr/deepgram';
import { formatSarvamPayload,   SarvamPayload }   from '../adapters/asr/sarvam';

// ──────────────────────────────────────────────────────────
// GET /retrieve/asr-bias
//
// Query params:
//   lang       string  (required) — BCP-47 language code
//   asr        string  (required) — adapter: whisper | deepgram-nova3 | sarvam
//   domain     string  (optional) — defaults to "restaurant"
//   tenant_id  string  (optional)
//   workflow   string  (optional) — maps to product_id subset
//
// Response:
//   { asr, lang, payload, term_count, latency_ms }
// ──────────────────────────────────────────────────────────

const SUPPORTED_ASR = ['whisper', 'deepgram-nova3', 'sarvam'] as const;
type AsrAdapter = typeof SUPPORTED_ASR[number];

const DEFAULT_DOMAIN = 'restaurant';

const router = Router();

router.get('/asr-bias', async (req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  const { lang, asr, domain, tenant_id, workflow } = req.query as Record<string, string | undefined>;

  if (!lang || lang.trim() === '') {
    res.status(400).json({ error: '`lang` query param is required' });
    return;
  }
  if (!asr || !SUPPORTED_ASR.includes(asr as AsrAdapter)) {
    res.status(400).json({
      error: `\`asr\` query param is required. Supported: ${SUPPORTED_ASR.join(', ')}`,
    });
    return;
  }

  const resolvedDomain = domain?.trim() || DEFAULT_DOMAIN;
  const resolvedTenant = (tenant_id?.trim() || (req.headers['x-tenant-id'] as string | undefined)) ?? undefined;

  try {
    const [rawVariants, menuNames] = await Promise.all([
      getPhoneticVariants(lang.trim(), resolvedDomain, resolvedTenant, workflow?.trim() || undefined),
      resolvedTenant ? getDistinctMenuNames(resolvedTenant).catch(() => []) : Promise.resolve([]),
    ]);

    // Strip placeholder phrases; prepend real item names as direct keyterms.
    const menuVariants = menuNames.map(name => ({ value: name, confidence: 1.0, intent_name: 'MENU_ITEM', tenant_id: resolvedTenant ?? null }));
    const variants = [
      ...menuVariants,
      ...rawVariants.filter(v => !v.value.includes('menu-item')),
    ];

    let payload: WhisperPayload | DeepgramPayload | SarvamPayload;

    switch (asr as AsrAdapter) {
      case 'whisper':
        payload = formatWhisperPayload(lang.trim(), variants);
        break;
      case 'deepgram-nova3':
        payload = formatDeepgramPayload(variants, config.thresholds.phoneticAmbiguity);
        break;
      case 'sarvam':
        payload = formatSarvamPayload(variants);
        break;
    }

    res.json({
      asr,
      lang:       lang.trim(),
      payload,
      term_count: variants.length,
      latency_ms: Date.now() - start,
    });
  } catch (err) {
    console.error('GET /retrieve/asr-bias error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────────────────────
// GET /retrieve/llm-context
//
// Query params:
//   lang       string  (required) — BCP-47 language code
//   domain     string  (optional) — defaults to "restaurant"
//   tenant_id  string  (optional)
//   workflow   string  (optional) — product_id subset
//   k          number  (optional) — max entries, default 30
//
// Response:
//   { lang, domain, context: [{intent, tier, phrases[]}], entry_count, latency_ms }
// ──────────────────────────────────────────────────────────

router.get('/llm-context', async (req: Request, res: Response): Promise<void> => {
  const start = Date.now();
  const { lang, domain, tenant_id, workflow, k } = req.query as Record<string, string | undefined>;

  if (!lang || lang.trim() === '') {
    res.status(400).json({ error: '`lang` query param is required' });
    return;
  }

  const resolvedDomain = domain?.trim() || DEFAULT_DOMAIN;
  const resolvedK      = k ? Math.max(1, Math.min(100, parseInt(k, 10))) : 30;

  if (k && isNaN(resolvedK)) {
    res.status(400).json({ error: '`k` must be a positive integer' });
    return;
  }

  try {
    const entries = await getLlmContextEntries(
      lang.trim(),
      resolvedDomain,
      tenant_id?.trim() || undefined,
      workflow?.trim()  || undefined,
      resolvedK,
    );

    res.json({
      lang:        lang.trim(),
      domain:      resolvedDomain,
      context:     entries,
      entry_count: entries.length,
      latency_ms:  Date.now() - start,
    });
  } catch (err) {
    console.error('GET /retrieve/llm-context error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
