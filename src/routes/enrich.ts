import { Router, Request, Response } from 'express';
import { enrich }                         from '../sdk/enrich';
import { updateEnrichOutcome, getEnrichCallById } from '../db/queries/enrich';
import { logMiss }                        from '../db/queries/semantic';

// ──────────────────────────────────────────────────────────
// POST /enrich
//
// Body params (all optional except phrase):
//   phrase          string  — the raw utterance
//   lang            string  — BCP-47 e.g. "hi-IN" (optional — auto-detected when omitted)
//   domain          string  — defaults to "restaurant"
//   tenant_id       string
//   user_id         string
//   workflow        string
//   product_id      string
//   include_context boolean — if true, enriched_context is populated
//
// Headers (body params take precedence when both provided):
//   X-Product-ID    → product_id
//   X-Tenant-ID     → tenant_id
//   X-User-ID       → user_id
//
// Response:
//   { call_id, intent, confidence, matched_head, match_type, latency_ms, enriched_context }
//
// ── PATCH /enrich/:call_id/outcome ──────────────────────
// Body: { outcome: 'correct' | 'incorrect' | 'abandoned' }
// Sets downstream_outcome on the call log.
// On 'incorrect': logs phrase back to lexos_misses (false positive loop).
// ──────────────────────────────────────────────────────────

const router = Router();

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Record<string, unknown>;

  // Header fallbacks — body takes precedence
  const product_id = (typeof body['product_id'] === 'string' ? body['product_id'] : null)
    ?? (req.headers['x-product-id'] as string | undefined)
    ?? undefined;
  const tenant_id  = (typeof body['tenant_id']  === 'string' ? body['tenant_id']  : null)
    ?? (req.headers['x-tenant-id']  as string | undefined)
    ?? undefined;
  const user_id    = (typeof body['user_id']    === 'string' ? body['user_id']    : null)
    ?? (req.headers['x-user-id']    as string | undefined)
    ?? undefined;

  const { phrase, lang, domain, workflow, include_context } = body;

  if (!phrase || typeof phrase !== 'string' || phrase.trim() === '') {
    res.status(400).json({ error: '`phrase` is required and must be a non-empty string' });
    return;
  }
  try {
    const result = await enrich({
      phrase:          phrase.trim(),
      lang:            typeof lang === 'string' && lang.trim() ? lang.trim() : undefined,
      domain:          typeof domain   === 'string' ? domain   : undefined,
      tenant_id,
      user_id,
      workflow:        typeof workflow === 'string' ? workflow : undefined,
      product_id,
      include_context: include_context === true,
    });

    res.json(result);
  } catch (err) {
    console.error('POST /enrich error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /enrich/:call_id/outcome ──────────────────────

const VALID_OUTCOMES = new Set(['correct', 'incorrect', 'abandoned']);

router.patch('/:call_id/outcome', async (req: Request, res: Response): Promise<void> => {
  const { call_id } = req.params;
  const { outcome } = req.body as { outcome?: string };

  if (!outcome || !VALID_OUTCOMES.has(outcome)) {
    res.status(400).json({ error: '`outcome` must be "correct", "incorrect", or "abandoned"' });
    return;
  }

  try {
    await updateEnrichOutcome(call_id, outcome as 'correct' | 'incorrect' | 'abandoned');

    // False positive loop: if incorrect, re-log the phrase to lexos_misses
    // so the generation pipeline can create a better explicit variant.
    if (outcome === 'incorrect') {
      const call = await getEnrichCallById(call_id);
      if (call && call.lang) {
        void logMiss({
          utterance:  call.input_phrase,
          lang:       call.lang,
          domain:     'restaurant',
          product_id: call.product_id ?? undefined,
          tenant_id:  call.tenant_id  ?? undefined,
          workflow:   call.workflow   ?? undefined,
        }).catch(err => {
          console.warn('logMiss (false positive) failed (non-fatal):', (err as Error).message);
        });
      }
    }

    res.json({ call_id, outcome, updated: true });
  } catch (err) {
    console.error('PATCH /enrich/:call_id/outcome error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
