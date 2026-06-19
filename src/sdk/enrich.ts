import { randomUUID }                                        from 'crypto';
import { exactMatch, logEnrichCall, getEnrichedContext }    from '../db/queries/enrich';
import type { EnrichedContext }                              from '../db/queries/enrich';
import { semanticMatch, logMiss, getTermLanguage }          from '../db/queries/semantic';
import { generateEmbedding }                                from '../adapters/cloudflare-ai';
import { withEnrichTrace }                                  from './trace';
import { recordInteraction }                                from '../db/queries/users';
import { detectLanguage }                                   from '../utils/detect-language';
import { classifyIntent, classifyRestricted }               from '../classifier/intent-classifier';
import { actionRecognized, pickItemAction, hasUnknownContent } from '../classifier/action-gate';
import { normalizeRoman }                                   from '../classifier/normalize';
import { tenantHasMenu, matchMenuItem, matchMenuItemLexical, loadTenantMenuTokens } from '../menu/menu-matcher';
import { config }                                           from '../config';

// Intents that name a specific menu item (require an item to be present).
const ITEM_INTENTS = new Set([
  'LEXOS_CART_ADD_ITEM', 'LEXOS_CART_REMOVE_ITEM',
  'LEXOS_CART_UPDATE_QUANTITY', 'LEXOS_PRICE_INQUIRY_ITEM',
]);
// Order-level intents that do NOT name a menu item.
const NON_ITEM_INTENTS = new Set([
  'LEXOS_ORDER_CHECKOUT', 'LEXOS_PRICE_INQUIRY_TOTAL', 'LEXOS_ORDER_CANCEL',
  'LEXOS_SPECIAL_REQUEST_PACKAGING', 'LEXOS_HELP_UNDO_ACTION',
  'LEXOS_GREETING', 'LEXOS_FAREWELL',
]);

// ──────────────────────────────────────────────────────────
// Enrich SDK — resolution order:
//   1. Exact match — COLLOQUIAL + CODE_MIXED variants.
//   2. Semantic stage:
//        • tenant has a menu → ground the item (lexical span → embedding
//          fallback); action from cue groups (remove/qty/price → else ADD).
//          Unknown salient word → miss. No item → classifier (order intents).
//        • no menu → per-language classifier + OOD gate + action-cue gate.
//      pgvector / centroids serve ONLY the OOD gate + language inference here,
//      never the intent decision.
//   3. Miss — log to lexos_misses, return null intent.
//
// Every call is logged to lexos_enrich_calls (fire-and-forget).
// ──────────────────────────────────────────────────────────

const DEFAULT_DOMAIN = 'restaurant';

export interface EnrichContext {
  phrase:           string;
  lang?:            string;   // optional — detected automatically when omitted
  domain?:          string;
  tenant_id?:       string;
  user_id?:         string;
  workflow?:        string;
  product_id?:      string;
  include_context?: boolean;
}

export interface EnrichResult {
  call_id:          string;
  intent:           string | null;
  confidence:       number;
  matched_head:     string | null;
  match_type:       'exact' | 'semantic' | 'miss';
  latency_ms:       number;
  detected_lang:    string | null;   // lang used for search (detected or passed in)
  enriched_context: EnrichedContext | null;
  matched_item?:    string | null;   // resolved menu item (slot), when grounded
}

export type { EnrichedContext };

/**
 * Enrich an utterance: exact match → semantic → miss.
 * Instrumented with LangSmith when LANGSMITH_API_KEY is set.
 *
 * Semantic path is skipped (falls straight to miss) if the
 * Cloudflare adapter throws (missing credentials, API down).
 */
export const enrich = withEnrichTrace(
  async (ctx: EnrichContext): Promise<EnrichResult> => {
    const start   = Date.now();
    const domain  = ctx.domain ?? DEFAULT_DOMAIN;
    const call_id = randomUUID();

    // Resolve language — caller-supplied takes precedence, then auto-detect.
    // null means uncertain → search runs without a language filter.
    const lang = ctx.lang ?? detectLanguage(ctx.phrase);

    // ── 1. Exact match ─────────────────────────────────────
    const exact = await exactMatch(ctx.phrase, lang, domain, ctx.tenant_id);

    if (exact) {
      // Fill the item slot for item-intents when the tenant has a menu (lexical).
      const matched_item = (ctx.tenant_id && ITEM_INTENTS.has(exact.intent))
        ? (await matchMenuItemLexical(ctx.tenant_id, ctx.phrase).catch(() => null))?.name ?? null
        : null;
      const latency_ms = Date.now() - start;

      const enriched_context = ctx.include_context
        ? await getEnrichedContext(exact.intent, lang ?? '', domain).catch(() => null)
        : null;

      const result: EnrichResult = {
        call_id,
        intent:           exact.intent,
        confidence:       exact.confidence,
        matched_head:     exact.matched_head,
        match_type:       'exact',
        latency_ms,
        detected_lang:    lang,
        enriched_context,
        matched_item,
      };
      void logEnrichCall({
        call_id,
        input_phrase:   ctx.phrase,
        matched_intent: result.intent,
        match_type:     'exact',
        latency_ms,
        tenant_id:      ctx.tenant_id,
        user_id:        ctx.user_id,
        workflow:       ctx.workflow,
        product_id:     ctx.product_id,
        lang,
      }).catch(err => {
        console.warn('logEnrichCall (exact) failed (non-fatal):', (err as Error).message);
      });
      if (ctx.user_id && lang) {
        recordInteraction(ctx.user_id, lang).catch(() => { /* fire-and-forget */ });
      }
      return result;
    }

    // ── 2. Semantic stage — classifier head + OOD gate ─────
    //
    // Decision rule: the discriminative classifier picks the intent; the
    // nearest-neighbour cosine similarity is used only as an out-of-domain
    // gate (is this phrase near ANY known vocabulary?). This replaces raw
    // NN-to-centroid, which confused phrases that share function words
    // ("ondu vada kodi" vs "bill kodi"). Falls back to NN when no model is
    // trained yet.
    let semantic: { intent: string; confidence: number; item?: string | null } | null = null;
    try {
      // Normalize romanized spelling so "thegddhu" embeds like "thegdhu" — the
      // classifier was trained on normalized text, so query must match.
      const embedding = await generateEmbedding(normalizeRoman(ctx.phrase));
      const hasMenu   = ctx.tenant_id ? await tenantHasMenu(ctx.tenant_id) : false;

      if (hasMenu) {
        // ── Menu is authoritative for items ─────────────────
        // Try to ground a menu item (lexical span → embedding fallback). A match
        // is strong in-domain evidence, so it BYPASSES the classifier/OOD gate
        // (those use intent-vocab centroids that may not cover menu items).
        const item = await matchMenuItem(ctx.tenant_id!, ctx.phrase, embedding, config.classifier.menuItemSimFloor);
        if (item) {
          // Unknown salient word ("ondu vada eseyiri") → miss, never guess.
          const menuTokens = await loadTenantMenuTokens(ctx.tenant_id!);
          if (!hasUnknownContent(ctx.phrase, lang, menuTokens)) {
            // Action from cues (remove/qty/price → else ADD), item from the menu.
            semantic = { intent: pickItemAction(ctx.phrase, lang), confidence: 0.9, item: item.name };
          }
        } else {
          // No menu item → order-level intent or miss. Use the classifier.
          const nn      = await semanticMatch(embedding, lang, domain, ctx.tenant_id, 0);
          const clsLang = lang ?? (nn ? await getTermLanguage(nn.term_id) : null);
          const cls     = classifyIntent(embedding, clsLang);
          if (cls && cls.prob >= config.classifier.probThreshold && (nn?.confidence ?? 0) >= config.classifier.oodSimFloor) {
            let intent = cls.intent;
            if (ITEM_INTENTS.has(intent)) {
              // item-intent but no item present ("bill dena", "cab") → wrong.
              const repick = classifyRestricted(embedding, clsLang, NON_ITEM_INTENTS);
              intent = (repick && repick.prob >= config.classifier.probThreshold && actionRecognized(ctx.phrase, clsLang)) ? repick.intent : '';
            } else if (!actionRecognized(ctx.phrase, clsLang)) {
              intent = '';
            }
            if (intent) semantic = { intent, confidence: cls.prob, item: null };
          }
        }
      } else {
        // ── No menu for this tenant → classifier + action-cue gate ──
        const nn      = await semanticMatch(embedding, lang, domain, ctx.tenant_id, 0);
        const clsLang = lang ?? (nn ? await getTermLanguage(nn.term_id) : null);
        const cls     = classifyIntent(embedding, clsLang);
        if (cls && cls.prob >= config.classifier.probThreshold && (nn?.confidence ?? 0) >= config.classifier.oodSimFloor
            && actionRecognized(ctx.phrase, clsLang)) {
          semantic = { intent: cls.intent, confidence: cls.prob };
        } else if (!cls && nn && nn.confidence >= config.thresholds.intentMatch) {
          semantic = { intent: nn.intent, confidence: nn.confidence }; // legacy NN fallback
        }
      }
    } catch (err) {
      console.warn('semantic stage failed (non-fatal):', (err as Error).message);
    }

    if (semantic) {
      const latency_ms = Date.now() - start;

      const enriched_context = ctx.include_context
        ? await getEnrichedContext(semantic.intent, lang ?? '', domain).catch(() => null)
        : null;

      const result: EnrichResult = {
        call_id,
        intent:           semantic.intent,
        confidence:       semantic.confidence,
        matched_head:     null,
        match_type:       'semantic',
        latency_ms,
        detected_lang:    lang,
        enriched_context,
        matched_item:     semantic.item ?? null,
      };
      void logEnrichCall({
        call_id,
        input_phrase:   ctx.phrase,
        matched_intent: result.intent,
        match_type:     'semantic',
        latency_ms,
        tenant_id:      ctx.tenant_id,
        user_id:        ctx.user_id,
        workflow:       ctx.workflow,
        product_id:     ctx.product_id,
        lang,
      }).catch(err => {
        console.warn('logEnrichCall (semantic) failed (non-fatal):', (err as Error).message);
      });
      if (ctx.user_id && lang) {
        recordInteraction(ctx.user_id, lang).catch(() => { /* fire-and-forget */ });
      }
      return result;
    }

    // ── 3. Miss ─────────────────────────────────────────────
    const latency_ms = Date.now() - start;
    const result: EnrichResult = {
      call_id,
      intent:           null,
      confidence:       0,
      matched_head:     null,
      match_type:       'miss',
      latency_ms,
      detected_lang:    lang,
      enriched_context: null,
    };

    void logEnrichCall({
      call_id,
      input_phrase:   ctx.phrase,
      matched_intent: null,
      match_type:     'miss',
      latency_ms,
      tenant_id:      ctx.tenant_id,
      user_id:        ctx.user_id,
      workflow:       ctx.workflow,
      product_id:     ctx.product_id,
      lang,
    }).catch(err => {
      console.warn('logEnrichCall (miss) failed (non-fatal):', (err as Error).message);
    });

    logMiss({
      utterance:   ctx.phrase,
      lang,
      domain,
      product_id:  ctx.product_id,
      tenant_id:   ctx.tenant_id,
      user_id:     ctx.user_id,
      workflow:    ctx.workflow,
    }).catch(err => {
      console.warn('logMiss failed (non-fatal):', (err as Error).message);
    });

    if (ctx.user_id && lang) {
      recordInteraction(ctx.user_id, lang).catch(() => { /* fire-and-forget */ });
    }
    return result;
  },
  'exact',
);
