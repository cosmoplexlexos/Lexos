# Lexos — Build Decisions

## Stack
| Concern | Choice | Reason |
|---------|--------|--------|
| Runtime | Node.js 20 + TypeScript | Type safety, good Supabase SDK |
| Database | Supabase (Postgres + pgvector) | pgvector pre-installed, free tier, no DevOps |
| Embeddings | Cloudflare Workers AI (`@cf/baai/bge-m3`, 1024d) | Multilingual (100+ languages), edge-hosted, free tier sufficient for demo |
| Generation | Claude Code (assistant in conversation) | API cost — Anthropic SDK must NOT be called for generation |
| API framework | Express.js | Simple, well-known, sufficient |
| Review UI | Retool (external — not in this codebase) | Connected directly to Supabase |
| Job scheduling | pg_cron (built into Postgres) | No extra service to run |

## Config constants — never hardcode these
| Constant | Starting value | What it controls |
|----------|---------------|-----------------|
| `INTENT_MATCH_THRESHOLD` | 0.55 | Cosine similarity floor for semantic match (lowered from 0.75 — bge-m3 multilingual scores top out at ~0.65 for paraphrases) |
| `PHONETIC_AMBIGUITY_THRESHOLD` | 0.85 | Soundex/Metaphone ceiling for ASR keyterm inclusion |
| `MISS_BATCH_TRIGGER_COUNT` | 5 | Minimum miss frequency before entering generation pipeline |
| `SEMANTIC_PROMOTE_THRESHOLD` | 10 | Minimum correct semantic matches before promoting to explicit variant |
| `CODE_MIXED_LOCALES` | hi-IN, en-IN, es-US | Locales that automatically expand search to CODE_MIXED variants |
| `GENERATION_BATCH_SIZE` | 15 | Entries per Claude API call — do not change without re-measuring parse failure rate |
| `CLASSIFIER_PROB_THRESHOLD` | 0.15 | Min softmax prob to accept a classifier intent. Low by design — correct in-domain runs as low as ~0.17; the action-cue gate (not this floor) is the safety net for unknown actions. |
| `CLASSIFIER_OOD_SIM_FLOOR` | 0.40 | Min nearest-centroid cosine to accept (out-of-domain gate). Below this → miss. |
| `MENU_ITEM_SIM_FLOOR` | 0.62 | Min cosine for an utterance to count as containing a tenant menu item. Validated separation: real items ~0.68+, non-items ~0.60-. Only used when the tenant has an ingested menu. |

## ASR engines
Lexos does NOT own the ASR connection. The consuming product's ASR engine manages its own session.
Lexos returns formatted vocabulary via adapters. Supported at launch:
- `deepgram-nova3` — string[] keyterm array, max 100
- `whisper` — coherent 200-token initial_prompt narrative
- `sarvam` — vocabulary hint JSON per Saarika V3 spec

## Key decisions already made
| Decision | Rationale |
|----------|-----------|
| ANALOGY variant dropped, replaced by CODE_MIXED | ANALOGY expensive to generate, rarely useful for ASR. CODE_MIXED is where voice AI actually fails. |
| Picovoice Rhino ruled out | Closed-domain only, no code-mixed Hinglish support |
| Batch size locked at 15 | Batch-50 hits ~25% JSON parse failure. Batch-15 stays under 8%. |
| FalkorDB rejected, pgvector used | Lexos query pattern is vector similarity, not graph traversal |
| No tenant admin UI for outlets | Miss loop captures outlet-specific slang automatically |
| /retrieve/asr-bias made ASR-agnostic | WiseOrder's ASR stack includes engines not in original Lexos design |
| bge-base-en-v1.5 (768d) replaced by bge-m3 (1024d) | English-only model produced noise scores (~0.65) for all Hindi/Tamil/etc phrases — bge-m3 is trained on 100+ languages |
| match_term_embeddings takes `text` not `vector` param | PostgREST can't introspect pgvector types; pass embedding as `[v1,v2,...]` string and cast inside the function |
| eval_sets unique index uses plain `(language_code, phrase)` | Supabase JS upsert `onConflict` doesn't support expression indexes like `LOWER(phrase)` |
| Variant trailing punctuation normalized on write and read | Generated phrases included Devanagari danda (।) — exact match failed unless both sides stripped |
| Semantic decision rule = discriminative classifier, NOT nearest-neighbour | NN over per-term centroids confused phrases sharing function words ("ondu vada kodi" vs "bill kodi") and missed novel phrasings — the centroid is a smeared average close to nothing. A per-language multinomial logistic-regression head over bge-m3 embeddings learns which tokens discriminate. Held-out adversarial eval: NN 10/34 → classifier 32/34. See `src/classifier/`, `scripts/train-intent-classifier.ts`, `scripts/eval-traps.ts`. |
| Classifier uses inverse-frequency class weighting | CART_ADD_ITEM has ~4× the variants of REMOVE/UPDATE_QUANTITY, so dish tokens ("vada") pulled everything to ADD ("vada beda" → ADD). Class weights stop the dominant class drowning minorities; also raised val accuracy. |
| Per-term centroids kept only as an OOD gate | The old per-term embeddings still exist in vector_embeddings; semanticMatch now serves only the "is this near any known vocab?" out-of-domain check, not the intent decision. True garbage rejection is imperfect (a menu/slot gate is the real fix) — gates are tuned lenient to avoid false misses on real phrases. |
| Classifier needs correct language | Per-language models; wrong language → confident-but-wrong (often ADD). WiseOrder always passes lang; demo dropped auto-detect and always sends a selected language. Retrain (`npx ts-node scripts/train-intent-classifier.ts`) after vocabulary changes. |
| Action-cue safety gate | A classifier always emits a best guess; an unknown action verb on a known item ("ondu vada <unknown>") defaults to ADD — confident-but-wrong, worse than a miss. The gate (`src/classifier/action-gate.ts`) accepts a classifier result only if the phrase has a recognized action cue (`action-cues.json`, curated verbs/markers) OR every non-filler token is known vocab (`vocab.json`, corpus-derived by the trainer). Unknown verb → miss; novel dish + known verb ("khara bath kodi") → still resolves. Because the gate handles unknown-action rejection, `CLASSIFIER_PROB_THRESHOLD` was lowered 0.18→0.15 to keep recall. Retraining also regenerates `vocab.json`. |
| Romanized spelling normalizer | Romanized Indic has no canonical spelling ("ondu/ondhu", "thegdhu/thegddhu"); short phrases on thin-signal classes flip on one letter. `src/classifier/normalize.ts` collapses aspiration (dh→d, th→t), doubled consonants (dd→d), and doubled vowels (aa→a), applied to BOTH training text and query → variants embed identically. Native script passes through untouched. |
| Menu grounding (intent + slot) | The deepest fix for "bill dena" (CHECKOUT) vs "vada dena" (ADD): give Lexos the tenant's menu so item-vs-generic is a *fact*, not a guess. Menu lives in DB (`menu_items`, migration 008), one row per **surface form** (English + each language + colloquial aliases) all sharing the canonical name — so "benne masale dose"/"ಮಸಾಲ ದೋಸೆ"/"masala dose" all → "Masala Dosa". Ingest via `scripts/ingest-menu.ts` or admin upload (both use `src/menu/expand.ts`). At enrich, `matchInMenu` (cosine over the tenant's item vectors — vectors are the RIGHT tool for item synonymy) detects if an item is present. **Composition (intent + slot):** item present → action from CUE GROUPS (`_item_actions` in action-cues.json: remove>qty>price>else-ADD), NOT the whole-phrase classifier (which conflated "kodi"=add vs "beda"=remove); returns `matched_item`. No item present → classifier restricted to ORDER-level intents (CHECKOUT/TOTAL/CANCEL/…) + action-cue gate, miss if none fits ("cab" → miss = OOD). Additive: only active when the tenant has a menu; tenants without one fall back to the classifier path. SAFETY: even with a matched item, if the phrase has an unrecognized salient token (not a menu token, action cue, or filler) → MISS, never a guessed intent ("ondu vada eseyiri" → miss). Menu surface-form tokens are stored in `tenant_profiles.seed_vocabulary.menu_tokens` for this gate (`hasUnknownContent`). A confident wrong intent is unacceptable. |
| Admin dashboard + per-tenant API keys | WiseOrder admin at `/admin` (single `LEXOS_ADMIN_KEY`): create tenant, upload menu, generate/revoke per-tenant API keys, retrain (background job, hot-reloads model). Keys hashed in `api_keys` (migration 008); `/enrich` resolves the tenant from the key (no tenant_id needed in the request). Vocabulary generation endpoint is built but gated behind `GENERATION_ENABLED` (off) per the no-API-generation rule. |

## Folder structure
```
/src
  /db          ← all database queries live here, never raw SQL in routes
  /routes      ← Express route handlers
  /adapters    ← per-ASR-engine formatting adapters
  /generation  ← Claude batch generation pipeline
  /sdk         ← /enrich endpoint logic (exact match + semantic + miss)
  /loops       ← miss loop + semantic promote loop (pg_cron jobs)
  /iral        ← IRAL v0 eval harness
/tests         ← one test file per route/module
/docs          ← ARCHITECTURE.md and PRD.md
/.claude/rules ← auto-loaded by Claude Code
```
