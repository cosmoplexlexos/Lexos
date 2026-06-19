# LEXOS — Architecture Document

> Voice Ordering — First Product  
> Internal tool. Serves our voice products. Simple to start. Designed to grow.

---

## 1. What Lexos Is

Lexos is middleware. It sits between a voice workflow and the ASR and LLM engines that the workflow already uses. It does not own the ASR connection, does not stream audio, and does not build or run a custom speech model. Its job is to make any ASR engine hear better and any LLM understand better — by preloading the right vocabulary context before a session starts, and resolving raw transcripts to clean intents in real time between STT output and LLM input.

The consuming product chooses its ASR engine. Lexos primes it. The consuming product chooses its LLM. Lexos enriches it. Lexos is engine-agnostic at both ends.

| Job | What it does | When it runs |
|-----|-------------|-------------|
| ASR Priming | Returns engine-specific vocabulary to the consuming product's ASR engine — primes it, does not own it | Before the session — a one-time setup call |
| LLM Injection | Returns relevant vocabulary as structured context to inject into the AI's system prompt at inference time | Per request, before the LLM processes the transcript |
| SDK Middleware | Resolves the raw transcript to a clean intent and enriched context. Exact match p99 ~5ms; semantic search p99 ~80ms; overall p99 ~100ms acceptable for voice at MVP | In real time, after every STT transcription |

---

## 2. System Architecture

### Lexos — Middleware Position

Lexos is middleware. It sits between the voice workflow and the ASR and LLM engines.

| Layer | Owned by | Lexos's role |
|-------|----------|-------------|
| Audio capture | Consuming product (device / app) | None — Lexos never receives raw audio |
| ASR (speech-to-text) | Consuming product (Deepgram, Whisper, Sarvam, etc.) | Primes the engine with domain vocabulary before the session starts, via /retrieve/asr-bias |
| Transcript → Intent resolution | Lexos (SDK hot path) | lexos.enrich() resolves the raw transcript to a canonical intent in real time |
| LLM context injection | Lexos → consuming product's LLM | Injects structured vocabulary context into the system prompt via /retrieve/llm-context |
| LLM response generation | Consuming product's LLM | None — Lexos delivers context; the LLM generates the response |
| TTS (text-to-speech) | Consuming product | None |

> **Lexos does not own ASR**
> - Lexos does not own the ASR streaming connection. It primes the engine; the product manages the session.
> - Lexos does not build a custom ASR model. It works with existing engines via their vocabulary biasing APIs.
> - Deepgram Nova-3 appears in examples because it is WiseOrder's first engine. It is not a Lexos dependency.

### Context-Aware Library Preloading

Lexos does not serve one monolithic vocabulary corpus at query time. It preloads targeted library subsets tuned to the specific workflow, language profile, and user context before the session begins. The preload is assembled by stacking four layers in order — each additive, each more specific than the previous.

| Layer | Scope | Populated by | Searched at |
|-------|-------|-------------|-------------|
| 1. Global corpus | All products, all tenants — NULL product_id and NULL tenant_id | Generation pipeline, miss loop, semantic promote loop | Last — fallback of last resort |
| 2. Workflow library | One workflow type: restaurant ordering, ticket booking, dictation… | Defined at workflow creation, refined from usage | Third |
| 3. Tenant profile | One specific B2B deployment: Theobroma Cafe, Mumbai local trains… | Configured at onboarding, refined from usage via miss and promote loops | Second |
| 4. User profile | One individual user — follows them across all products | Learned automatically from usage; user can set explicit preferences | First — most specific, fastest match |

At resolution time, the SDK searches in reverse order — user profile first, then tenant profile, then workflow library, then global corpus. The first match wins.

### Workflow Examples

| Workflow + Tenant | Preloaded library subset | Why this combination matters |
|-------------------|------------------------|------------------------------|
| South Indian restaurant (Saravana Bhavan, Chennai) | ta-IN, te-IN, kn-IN + QSR domain + Jain menu intents + Tamil address forms + rice dish vocabulary | A user ordering in Tamil at a Chennai Saravana Bhavan uses vocabulary that a global Hindi model has never seen. |
| Cafe chain (Theobroma, Mumbai) | en-IN dominant + QSR domain + pastry vocabulary ('dark indulgence', 'choco lava') + eggless intent + Mumbai urban register | Theobroma's customers are English-dominant Mumbai urbanites. Same workflow, completely different tenant profile. |
| Train ticket booking (Mumbai local) | hi-IN + mr-IN · station names (CST, Dadar, Virar) · fast/slow local distinction · season ticket vocabulary | Mumbai local train vocabulary is hyperlocal. Generic transport vocabulary doesn't cover it. |
| Train ticket booking (Pune intercity) | hi-IN + mr-IN · Shivajinagar, Hinjewadi context · different station set · intercity journey patterns | Same workflow, different station names, different vocabulary profile entirely. |
| Train ticket booking (Tier 2 town) | Regional language dominant · lower English code-mixing · different literacy patterns · local station names | A user in a tier 2 town speaks very differently from a Mumbai commuter. |
| Personal mobile vocabulary (Individual user) | User's native language · habitual phrases learned over sessions · personal names · preferred registers across all their apps | A user's vocabulary follows them. If they always say 'saapidum' instead of 'eat', every product they use via Lexos resolves it instantly. |

### Personal Vocabulary — Cross-App Learning

For personal mobile usage, Lexos functions as a persistent personal vocabulary layer spanning all voice interfaces on a device. The same architecture as the domain-specific library system, with tenant_id scoped to the individual user rather than an outlet or cohort.

### API Service Vision

The architecture is designed to be exposed as an API service for any voice or LLM product. The only additions needed are authentication, billing metering, and rate limiting at the API gateway layer.

### Tenant Profile — B2B Onboarding Configuration

| Configuration field | Description | Who sets it |
|--------------------|-------------|------------|
| primary_language | Dominant language code of the customer base (e.g. ta-IN, en-IN, hi-IN) | B2B customer at onboarding |
| geographic_region | City or region — affects vocabulary, register, and language mixing patterns | B2B customer at onboarding |
| register_preference | formal / colloquial / mixed | B2B customer at onboarding |
| customer_demographic | JSONB — age range, tech familiarity, literacy profile | B2B customer at onboarding |
| seed_vocabulary | JSONB — product-specific terms: menu items, location names, brand terms | B2B customer via /tenants/:id/vocabulary |
| tenant_specific_intents | Custom intent IDs unique to this deployment | B2B customer at onboarding, reviewed by curator |

### User Profile — Individual Personalisation

| Profile component | How built | How used |
|-------------------|-----------|----------|
| Native language | Inferred from phrase patterns — which language's vocabulary they use most | Weights the preload toward their dominant language |
| Geographic region | Inferred from place names, regional terms, and routing metadata | Loads region-specific vocabulary variants |
| Explicit preferences | User-set via PATCH /users/:user_id/preferences — optional | Overrides inferred values for those dimensions only |
| Habitual phrases | High-frequency semantic matches from their sessions | Promoted to explicit variants in their personal profile (~5ms exact match) |
| Personal vocabulary | Phrases introduced by this user that weren't in any corpus layer | Added to their personal profile. Available on any product they use. |
| Cross-product continuity | Profile stored against user_id (tenant_id = user_uuid), not product_id | Vocabulary follows them across all Lexos-integrated products |

> **User profiles are strictly private.** No phrase from a user's personal profile is ever promoted to the tenant or global corpus without explicit human review.

### How the Personalisation Stack Works in Practice

When WiseOrder starts a session for a user at a Theobroma Cafe outlet in Mumbai:

1. Start with global corpus — all restaurant intents in all languages
2. Layer the QSR workflow library on top — restaurant-domain vocabulary, all Tier A languages
3. Layer Theobroma's tenant profile — their menu items, Mumbai English-dominant register, eggless intent
4. Layer this user's personal profile — their habitual phrases, native language weighting, explicit preferences

The SDK searches in reverse. The user's personal phrase 'lava cake dena' resolves in ~5ms from their personal profile. A miss at any layer feeds all three loops simultaneously: the global miss loop, the tenant-level promote loop, and the user-level promote loop.

### Before the Call — Vocabulary Preloading

One-time setup call per session. The consuming product calls /retrieve/asr-bias with workflow, language, and user profile. Lexos returns the vocabulary subset formatted for the product's ASR engine via a thin adapter.

### During the Call — Real-Time Intent Resolution

After ASR produces a transcript, it is passed to lexos.enrich() before reaching the LLM. The SDK resolves the raw transcript to the closest matching intent and returns: intent ID, confidence score, matched variant head, plain-English context string.

If the SDK cannot match the phrase, it returns null and logs to the misses table. That feeds the next preload cycle for that workflow and user profile.

---

## 3. Tech Stack

| Tool | Role in Lexos | Why this one |
|------|-------------|-------------|
| Any ASR engine (Deepgram Nova-3 / Whisper / Sarvam Saarika / Azure) | Not owned by Lexos — the consuming product's choice. Lexos primes it via /retrieve/asr-bias adapter. | Deepgram Nova-3 is WiseOrder's first engine. Lexos supports all via thin per-engine adapters. |
| PostgreSQL | Primary database — stores everything | Handles relational data and vector search in one place. No need for two separate databases at MVP. |
| pgvector | Semantic similarity search inside Postgres | Adds vector search to Postgres with zero extra infrastructure. Same DB, same transactions. |
| Supabase or Neon | Managed PostgreSQL hosting | pgvector pre-installed on both. Generous free tiers, no DevOps burden. |
| Cloudflare Workers AI | Generates meaning vectors (embeddings) | Runs at the network edge. Fast, no cold starts, no GPU to manage, pay-per-use. |
| Claude / GPT API | Generates vocabulary entries in batches | Batch size locked at 15 entries per call — larger batches cause ~25% JSON parse failure. |
| Cohere rerank-multilingual-v3.0 | Reranks vector search results for LLM injection | Phase 2 only. +20-35% accuracy lift on /retrieve/llm-context. 100+ languages. |
| Redis | Caches known phrase → intent lookups for preloaded library hot path | Not needed at launch — add only when SDK p99 > 60ms in production. |
| pg_cron | Schedules the miss-to-generation batch job | Built into Postgres. No extra service to run. |

---

## 4. Data Schema

See `.claude/rules/schema.md` for the full SQL migration.

### Tables

| Table | What it holds | Key columns |
|-------|-------------|-------------|
| lexos_intents | Canonical intent IDs — the language-agnostic goals | intent_id, intent_name, domain, product_id (NULL = global) |
| lexos_terms | One row per phrase per language per domain | intent_id, language_code, domain, tier, product_id, tenant_id, active, valid_from, valid_until, superseded_by, hit_count, last_hit_at, success_after_hit, miss_after_hit |
| term_variants | The actual text — one row per variant type | term_id, variant_type (FORMAL/COLLOQUIAL/CODE_MIXED/PHONETIC), value, confidence |
| vector_embeddings | Meaning vectors for semantic search | term_id, embedding (vector), model_version, model_name |
| lexos_entries_staging | AI-generated entries awaiting review | All term fields + status, rollback_of, eval_passed, eval_regression |
| lexos_misses | Every utterance the system failed to match | utterance, lang, domain, product_id, tenant_id, frequency |
| lexos_enrich_calls | Trace log of every SDK call | input_phrase, matched_intent, match_type, latency_ms, downstream_outcome |
| audit_log | Immutable record of every human correction | term_id, field_changed, old_value, new_value, editor, timestamp |
| tenant_profiles | Configuration profile for each B2B tenant deployment | tenant_id, primary_language, geographic_region, register_preference, seed_vocabulary JSONB |
| user_profiles | Individual user personalisation profile | user_id, native_language, geographic_region, explicit_preferences JSONB, learned_patterns JSONB |

### Day-One Schema Constraints

> **CRITICAL — Run before inserting any vector data:**  
> `ALTER TABLE vector_embeddings ALTER COLUMN embedding SET STORAGE PLAIN`  
> Prevents TOAST from pushing vectors to secondary storage, which makes similarity search catastrophically slow.

**Bi-temporal validity on lexos_terms — Day One**  
`valid_from TIMESTAMP DEFAULT NOW(), valid_until TIMESTAMP NULL, superseded_by UUID NULL`  
Corrections are invalidation events, not overwrites. SDK filters: `WHERE NOW() BETWEEN valid_from AND COALESCE(valid_until, 'infinity')`

**Usage analytics on lexos_terms — Day One**  
`hit_count BIGINT DEFAULT 0, last_hit_at TIMESTAMP, success_after_hit BIGINT DEFAULT 0, miss_after_hit BIGINT DEFAULT 0`  
Entries with zero hits in 90 days are candidates for sunset review.

**Model versioning on vector_embeddings — Day One**  
`model_version VARCHAR(64), model_name VARCHAR(128)`  
Required for backfill-safe embedding model upgrades.

### product_id and tenant_id — Scoping at Two Levels

| Scope | Meaning |
|-------|---------|
| product_id = NULL | Global — visible to all products |
| product_id = 'wiseorder' | Private to WiseOrder |
| tenant_id = NULL | Shared across all tenants of that product |
| tenant_id = 'outlet-uuid' | Private to that specific outlet |
| tenant_id = 'user-uuid' | Private to that specific user |

---

## 5. Storage and Scaling

| Phase | What changes | Trigger |
|-------|-------------|---------|
| 1 — Start here | Postgres + pgvector. HNSW index (m=16, ef=128). No cache. All queries go direct to the database. | Default starting point |
| 2 — Add caching | Add Redis. Store known phrase → intent_id as an in-memory hash. O(1) lookup for common phrases. | SDK p99 latency exceeds 60ms in production |
| 3 — Add Qdrant | Move vector search to Qdrant as a dedicated vector database. Postgres remains the source of truth. | Vector corpus exceeds 500,000 entries |

### What We Are Not Building Yet

| Deferred item | Build when… |
|--------------|------------|
| Redis cache | SDK p99 exceeds 60ms in production |
| Aho-Corasick trie | Redis hash is measured as insufficient |
| ONNX WASM local embedding | Cloudflare AI cost or latency is a measured problem |
| Azure Custom Speech pipeline | Corpus large enough to justify retraining cost |

---

## 6. ASR Integration

Lexos is ASR-agnostic. It returns a **standard structured format** — the consuming product is responsible for adapting that to their ASR engine. Lexos does not maintain per-engine adapters as a primary integration path.

### Standard Output Format

`GET /retrieve/asr-bias` returns structured JSON:
```json
{
  "lang": "hi-IN",
  "workflow": "south-indian-restaurant",
  "terms": [
    { "intent": "LEXOS_CART_ADD_ITEM", "variants": ["masala dosa", "Ek masala dosa"], "phonetic": "muh-saa-laa doe-saa" }
  ]
}
```

The consuming product takes this and formats it for their engine. Lexos is not in the business of tracking every ASR vendor's API format.

### Reference Adapters (optional convenience)

Thin adapter implementations are provided as reference — useful if the consuming product wants Lexos to do the formatting. These are convenience helpers, not the primary integration path.

| Engine | Format | Status |
|--------|--------|--------|
| Deepgram Nova-3 | string[] keyterm array, max 100, model-native | Reference impl available |
| Whisper | Coherent 200-token initial_prompt narrative (not a comma list) | Reference impl available |
| Sarvam Saarika | Vocabulary hint JSON per Saarika V3 spec | Reference impl available |
| Azure Custom Speech | Async UTF-8 BOM .tsv file upload | Backlog |

### Phonetic Ambiguity Checking

CODE_MIXED and COLLOQUIAL variants above PHONETIC_AMBIGUITY_THRESHOLD (default 0.85, Soundex/Metaphone) are excluded from Nova-3 payloads to prevent hallucination. Store this threshold in config, never hardcode it.

---

## 7. SDK Middleware

The SDK is a thin HTTP client wrapping the /enrich endpoint. Every call is logged to lexos_enrich_calls with its match_type. This trace log feeds two automatic improvement loops:

- **Miss loop**: null results → ranked by frequency → generation pipeline → new entries
- **Semantic promote loop**: high-frequency correct semantic matches → explicit variants → future matches drop from ~80ms to ~5ms

### Resolution Steps

| Step | What happens | Target latency | On miss |
|------|-------------|----------------|---------|
| 1. Exact match | Checks if the utterance matches a known COLLOQUIAL or CODE_MIXED variant directly. Fast and reliable for phrases already seen. | ~5ms | Step 2 |
| 2. Classifier | Cloudflare Workers AI generates a meaning vector; a trained per-language intent classifier predicts the intent; an out-of-domain gate decides accept-or-miss. Catches new phrasings, misspellings, synonyms. | ~80ms | Step 3 |
| 3. No match | Returns { intent: null, confidence: 0 }. Logs to lexos_misses asynchronously. Never blocks the LLM call. | instant | Log and return null |

### Step 2 is a classifier, not nearest-neighbour (changed 2026-06)

The semantic stage originally took the nearest pgvector centroid as the intent.
That failed for closed-set intent classification: each intent's embedding was a
single vector built by concatenating all of its variants — a *smeared centroid*
that sat close to nothing and confused phrases sharing function words
("ondu vada kodi" = ADD vs "bill kodi" = CHECKOUT, both contain "kodi").
Lowering the threshold only traded misses for false positives — the geometry
itself was wrong.

It now works as:

1. **Exact match** (unchanged).
2. **Classifier** — a per-language multinomial logistic-regression head over the
   frozen bge-m3 embedding picks the intent. It *learns* that a shared token
   like "kodi" is non-discriminative and that "bill" vs a menu item is the
   signal. Trained offline with inverse-frequency class weighting (so the large
   CART_ADD_ITEM class can't drown out REMOVE / UPDATE_QUANTITY). Inference is a
   sub-millisecond matrix multiply.
3. **Acceptance gates** — accept the classifier's intent only when: probability ≥
   `CLASSIFIER_PROB_THRESHOLD`, the nearest known vocabulary is within
   `CLASSIFIER_OOD_SIM_FLOOR` cosine (out-of-domain check over the old centroids),
   **and** the action-cue gate passes. Otherwise return a miss.

**Action-cue gate** (`src/classifier/action-gate.ts`): a classifier always emits
a best guess, so an *unknown action verb* on a known item ("ondu vada &lt;unknown&gt;")
would default to ADD — confident-but-wrong, worse than a miss. The gate accepts
only if the phrase contains a recognized action cue (`action-cues.json` — curated
verbs/markers, no dish nouns or numbers) **or** every non-filler token is known
vocabulary (`vocab.json`, regenerated from the corpus by the trainer). So an
unknown verb → miss, while a novel dish with a known verb ("khara bath kodi")
still resolves. Because this gate handles unknown-action rejection, the prob
floor is kept low (0.15) for recall.

Held-out adversarial eval: nearest-neighbour 10/34 → classifier 32/34.

**Menu grounding (intent + slot).** The classifier alone can't tell "bill dena"
(CHECKOUT) from "vada dena" (ADD) — both are "X + give", and "vada"/"bill" look
the same to it. The fix is to give Lexos the tenant's **menu**, so "is this an
item?" is a fact, not a statistical guess. WiseOrder provides a structured menu;
`scripts/ingest-menu.ts` embeds each item with bge-m3 into `src/menu/<tenant>.json`.
At resolution, `matchMenuItem` compares the utterance embedding to the tenant's
item vectors — *semantic similarity is the right tool here* (the opposite of
intent): "filter kaapi" ≈ "Filter Coffee" (0.74), while "bill"/"cab" match no
item. Composition: an item-intent (ADD/REMOVE/UPDATE/PRICE_ITEM) with **no** menu
item present is wrong — re-pick the best ORDER-level intent (CHECKOUT / TOTAL /
CANCEL / PACKAGING …), and miss if none fits. This resolves "bill dena" →
CHECKOUT, "vada dena" → ADD (item=Vada), and "I want a cab" → miss (out of
domain — finally principled). The layer is additive: active only when the tenant
has an ingested menu, otherwise the classifier path runs unchanged. The matched
item is returned as a slot (`matched_item`).

A romanized-spelling normalizer (`src/classifier/normalize.ts`) is applied before
embedding on both training and query text, so "thegddhu" ≈ "thegdhu" resolve the
same — short romanized phrases were otherwise flipping on a single letter.

**Operational rules:**
- Model artifact: `src/classifier/model.json` (per-language weights), loaded by
  `src/classifier/intent-classifier.ts`, wired into `src/sdk/enrich.ts`.
- **Retrain after any vocabulary change:** `npx ts-node scripts/train-intent-classifier.ts`
  (offline; calls only Cloudflare bge-m3, never the Anthropic API). Restart the
  server afterwards — the model is cached in memory.
- The classifier needs the correct language. WiseOrder always passes `lang`;
  callers should too. Auto-detection is a best-effort fallback only.
- Regression net: `scripts/run-intent-eval.ts <file>` (broad per-intent) and
  `scripts/eval-traps.ts` (held-out adversarial, NN vs classifier).
- True out-of-domain rejection ("I want a cab" → ADD) remains imperfect — intent
  classification alone can't know an entity isn't on the menu. A menu/slot
  validation layer is the planned follow-up.

**Latency budget:**  
Exact match p99 ~5ms · Semantic search p99 ~80ms · Overall p99 ~100ms at MVP  
The `<40ms` figure refers to the exact-match hot path only. 40ms overall is achievable in Phase 2 once Redis eliminates the semantic path for known phrases.

### Confidence Threshold

INTENT_MATCH_THRESHOLD now governs only the legacy nearest-neighbour fallback
(used when no classifier model is present). The live decision uses
`CLASSIFIER_PROB_THRESHOLD` (accept floor on classifier probability) and
`CLASSIFIER_OOD_SIM_FLOOR` (out-of-domain cosine floor). Both are deliberately
lenient — a false miss on a real phrase is worse than occasionally passing an
off-domain phrase to the downstream LLM. Calibrate from held-out data
(`scripts/eval-traps.ts`), not from a fixed target.

### Code-Mixed Handling

Code-mixed phrasings are handled directly by the per-language classifier (trained
on COLLOQUIAL + CODE_MIXED variants) and the romanized-spelling normalizer
(`src/classifier/normalize.ts`) — not by a separate locale-expansion step. The
old `CODE_MIXED_LOCALES` search-expansion strategy was removed.

---

## 8. Generation Pipeline

> **DORMANT (2026-06).** This runtime generation→staging→IRAL→review→promote flow
> is NOT active. The app must never call the Anthropic API (see `CLAUDE.md`); all
> vocabulary is generated by the assistant in conversation and inserted via
> scripts, and per-tenant items come from the uploaded menu. The pipeline,
> `src/generation/`, the miss/semantic-promote loops, IRAL, and the staging/review
> UI remain in the codebase as a dormant design but are not part of the live path.
> Sections 8–9 and 15 describe that dormant design.

### The Flow

Intent × Language matrix → Claude batch-15 → Parser/validator → lexos_entries_staging → IRAL v0 eval → Human review → Promotion → Embedding generation (never before promotion)

### What Each Generation Batch Produces

- Proposed LEXOS_INTENT mapping
- All four variant heads — FORMAL, COLLOQUIAL, CODE_MIXED, PHONETIC
- Confidence score per field (0.0–1.0)
- Whisper initial_prompt narrative — coherent 200-token sentence
- Azure .tsv phonetics — stored for later
- Phonetic ambiguity flag on CODE_MIXED variants

> **Batch size fixed at 15 per Claude API call.** Batch-50 hits ~25% JSON parse failure. Batch-15 stays under 8%.

> **Every LLM-generated entry goes to staging first. Always.** LLM output never writes directly to the live database.

### IRAL v0 — Automated Eval Before Human Review

A frozen labeled eval set that runs automatically on every staging entry before a reviewer can approve it.

- **100 (phrase, correct_intent) pairs per language**, maintained by the platform team
- **Forward regression check**: does adding this entry break any existing correct match?
- **Backward recall check**: does the SDK return the correct intent for held-out eval phrases?
- If regression check fails, the approve button is **disabled**

### Graduated Autonomy in the Staging Gate

| Stake level | Entry type | Required gate |
|-------------|-----------|--------------|
| Low | New variant of existing intent in existing language | Auto-approve if IRAL eval passes. Log for spot-review. |
| Medium | New variant of existing intent in a new language | Single native-speaker reviewer required. |
| High | New intent ID, any language | Two reviewers required. IRAL regression check must pass. |
| Critical | Intent maps to a financial or safety action (confirm, cancel, refund) | Two reviewers + IRAL check + 7-day shadow period before full promotion. |

### The Miss Loop

Every failed intent resolution → lexos_misses → pg_cron ranks by frequency → top-N above MISS_BATCH_TRIGGER_COUNT → fed to generation pipeline as the next batch.

### The Semantic Promote Loop

High-frequency correct semantic matches → above SEMANTIC_PROMOTE_THRESHOLD → generation pipeline as explicit variant candidates for existing intents.

The generation prompt is different: it receives the phrase and the confirmed correct intent, and generates the full set of variant heads. Over time, common phrases migrate from the 80ms semantic path to the 5ms exact match path automatically, purely from usage.

**Two input signals, one pipeline:**
- Miss loop: `lexos_misses.frequency > MISS_BATCH_TRIGGER_COUNT` → generate new entry for unknown phrase
- Semantic promote loop: `lexos_enrich_calls WHERE match_type = 'semantic' AND downstream_outcome = 'correct', frequency > SEMANTIC_PROMOTE_THRESHOLD` → generate explicit variant for known intent

---

## 9. Human Review UI

Build in Retool at MVP. Minimum required fields:

| Field | Why mandatory |
|-------|--------------|
| Intent ID + plain English description | Reviewer must understand what the intent means |
| Language + domain + tier (A/B/C) | Context for whether the phrase is appropriate |
| All four variant heads side by side | Reviewing in isolation causes approval errors |
| Confidence score per field, visually highlighted | Low-confidence fields must be visually distinct |
| IRAL eval result — inline, mandatory | Regression check (pass/fail) and recall check must be visible. Approve disabled if regression fails. |
| Inline edit per field | One-field corrections must take under 10 seconds |
| Approve / Edit+Approve / Reject | Editing and approving must be a single atomic action |
| Stake level badge (Low/Medium/High/Critical) | Reviewers need to know how much scrutiny is required |
| Rollback flag with visual distinction | Rollback entries require extra scrutiny — flag must be unmissable |

---

## 10. API Design

### Data API — Internal

```
POST   /entries/staging              — LLM batch writes to staging
POST   /entries/staging/:id/promote  — human promotes with optional edits; triggers IRAL eval
POST   /entries/:id/rollback         — soft-delete + re-stage for re-review
PATCH  /entries/:id                  — human correction on a live entry
GET    /entries?lang=&domain=&intent=&product_id=&tenant_id=
DELETE /entries/:id                  — soft delete only (sets active = false)
POST   /tenants/:tenant_id/configure — B2B onboarding — sets language, region, register, demographic
POST   /tenants/:tenant_id/vocabulary — seed vocabulary upload
GET    /tenants/:tenant_id/profile   — view current tenant profile
PATCH  /users/:user_id/preferences  — user sets explicit language preferences
GET    /users/:user_id/profile       — view current user profile
```

### Retrieval API — Called by Voice Products

```
GET /retrieve/llm-context
    ?utterance=&lang=&domain=&product_id=&tenant_id=&workflow=
    → top-k entries as structured JSON for LLM system prompt injection

GET /retrieve/asr-bias
    ?lang=&domain=&product_id=&tenant_id=&workflow=&format=deepgram-nova3|whisper|sarvam|azure
    → normalized keyterms translated to engine-specific format by adapter
```

### Enrich Endpoint — SDK Hot Path

```
POST /enrich
Headers: X-Product-ID: voice-ordering | X-Tenant-ID: outlet-uuid | X-User-ID: user-uuid
Body:    { utterance, lang, domain, workflow?, user_id? }
Returns: { intent, confidence, matched_head, enriched_context, match_type, latency_ms }
Failure: { intent: null, confidence: 0 } — returned within 10ms if service unreachable
```

---

## 11. MVP vs Production

| Layer | MVP — Ship This | Production — Grow Into |
|-------|----------------|------------------------|
| ASR Engine | Deepgram Nova-3 (WiseOrder's choice) | Same — additional products may use Whisper or Sarvam |
| Database | Supabase or Neon Postgres + pgvector | Add PgBouncer for connection pooling |
| Vector Index | HNSW m=16, ef=128 | HNSW m=32, ef=256 for better recall |
| Vector DB | pgvector only | Qdrant when corpus exceeds 500k entries |
| Cache | None — direct pgvector | Redis inverted index for SDK hot path |
| Bi-temporal | valid_from/until/superseded_by in first migration | SDK filters using bi-temporal clauses |
| Usage analytics | hit_count, last_hit_at, success/miss_after_hit in first migration | Stale-entry pruning job active |
| Eval harness | IRAL v0: 100-pair frozen set per language | IRAL v1: LoRA judge replacing ~50% of Claude API gate calls |
| Autonomy level | Binary staging gate (AI_DRAFT → review → live) | Graduated: low/medium/high/critical stake levels |
| Tenant isolation | tenant_id in first migration | Per-tenant entries active |
| Personalisation | tenant_profiles + user_profiles in first migration | Full inference pipeline active |

---

## 12. Before the First Line of Code

### First Migration Must Include

- product_id on lexos_terms and lexos_intents
- tenant_id on lexos_terms
- valid_from, valid_until, superseded_by on lexos_terms
- hit_count, last_hit_at, success_after_hit, miss_after_hit on lexos_terms
- model_version and model_name on vector_embeddings
- lexos_entries_staging with eval_passed and eval_regression
- lexos_misses
- lexos_enrich_calls
- audit_log
- tenant_profiles
- user_profiles
- `ALTER TABLE vector_embeddings ALTER COLUMN embedding SET STORAGE PLAIN`

### Phase 0 — Before Writing Product Code

| Deliverable | Why before code | Effort |
|------------|-----------------|--------|
| IRAL v0 eval set (100 pairs × Tier A languages) | The staging gate is only as trustworthy as the eval set behind it. Build before the first entry is generated, not after. | 1–2 days per language with a native speaker |
| Tracing on lexos.enrich() | The 80ms semantic path latency is unverified. Tracing makes debugging and latency measurement possible from day one. | Half a day — instrument the SDK, configure LangSmith or equivalent |
| DECISIONS.md log started | The ANALOGY drop, the Picovoice Rhino ruling, the batch-15 lock — these decisions will be forgotten in 6 months without a log. | One hour — start the file, document decisions already made |

### Config Constants — Never Hardcode These

| Constant | Start value | Notes |
|----------|------------|-------|
| INTENT_MATCH_THRESHOLD | 0.55 | Floor for the legacy NN fallback / OOD probe (lowered from 0.75 — bge-m3 paraphrases top out ~0.65) |
| CLASSIFIER_PROB_THRESHOLD | 0.15 | Min classifier softmax prob to accept. Low by design; the action-cue gate (not this floor) rejects unknown actions |
| CLASSIFIER_OOD_SIM_FLOOR | 0.40 | Min nearest-centroid cosine to accept a classifier result; below → miss |
| PHONETIC_AMBIGUITY_THRESHOLD | 0.85 | Soundex/Metaphone ceiling for Nova-3 keyterm inclusion |
| MISS_BATCH_TRIGGER_COUNT | 5 | Minimum miss frequency before entering generation pipeline |
| SEMANTIC_PROMOTE_THRESHOLD | 10 | Lower than MISS_BATCH_TRIGGER_COUNT because intent already confirmed |

> **Language scope (2026-06):** 5 active languages — hi-IN, kn-IN, mr-IN, ta-IN,
> te-IN. bn-IN, gu-IN, es-ES, ar-AE are disabled (`active=false`, embeddings
> purged from the index); toggle with `scripts/toggle-languages.ts`.

---

## 13. DB Architecture — Intent & Context Graph

### Why a Graph, Not a Flat Table

A flat table overwrites corrections — history lost. A bi-temporal graph records corrections as invalidation events. The old entry gets valid_until set. The new entry gets valid_from. The full provenance chain is always queryable.

### Graph Layer Structure

| Layer | What it stores | Why it matters |
|-------|---------------|----------------|
| Intent nodes | Canonical LEXOS_INTENT IDs — language-agnostic, domain-scoped | The anchor point. Every phrase in every language resolves to one of these. |
| Term variant edges | Typed links: formal-of, colloquial-of, codemixed-of, phonetic-of | Edges make relationships queryable. |
| Vector embeddings | pgvector columns on term nodes — semantic similarity at query time | Fuzzy search without a second database. |
| Bi-temporal edges | valid_from, valid_until, source_episode_id, confidence on every edge | Corrections are invalidations not overwrites. Full history always preserved. |
| Skill index | Verified generation prompts indexed by (language, register, domain) | Every successful batch generation becomes a reusable skill. |

---

## 14. LLM-Agnostic Integration

Lexos is infrastructure, not an LLM. It enriches whatever model your product already uses. A product can swap GPT-4o for Claude Sonnet for Sarvam-M without touching anything in Lexos.

### Three Integration Points

| Integration | How it works | Which models it works with |
|------------|-------------|--------------------------|
| LLM Injection /retrieve/llm-context | Call before sending the user's message to any LLM. Lexos returns structured vocabulary JSON. Drop it into the system prompt. | GPT-4o, Claude Sonnet, Gemini, Sarvam-M, Llama 3, Mistral |
| ASR Priming /retrieve/asr-bias | Call at session start. Returns engine-specific formatted vocabulary via adapter. | Deepgram Nova-3, Whisper, Sarvam Saarika, Azure Custom Speech |
| SDK Enrichment /enrich | Call between STT output and LLM input. Exact match p99 ~5ms; semantic match p99 ~80ms; overall p99 ~100ms at MVP. | Model-agnostic |

### The Karpathy LLM-OS Frame

LLM = CPU · Context window = RAM · Lexos = peripheral (vocabulary I/O) + persistent storage (intent graph) · Your voice product = the application running on top.

### Adaptive Compute Routing

Because Lexos handles intent resolution, the LLM can be routed by complexity. High-confidence Lexos results → smaller, cheaper model (Sarvam-M, Haiku). Low-confidence or null → escalate to larger model. Lexos provides the routing signal.

---

## 15. Learning System

### Learning Gate

Every Claude batch-15 generation output passes through four-axis scoring: schema validity, native-speaker plausibility, phonetic correctness, no-duplicate. Entries scoring 4/4 with high judge-confidence are auto-approved. 3/4 → human review. ≤2/4 → discarded, logged to misses.

After 4 weeks of operation, the accumulated decisions train a local LoRA judge (IRAL v1) on Sarvam-M that replaces ~50% of Claude API gate-scoring calls.

### Segment Audits — Per-Domain Isolation

| Segment | LoRA adapter scope | Independent metric |
|---------|-------------------|-------------------|
| Restaurant (QSR) | Order vocabulary, upsell phrases, outlet-level personalization | IRAL score per restaurant domain |
| Dictation | Professional transcription vocabulary, medical/legal register | IRAL score per dictation domain |
| Custom verticals | New segment added without rewriting the base model | IRAL score per new segment |

### Federated LoRA Adapter Architecture

Per-segment adapters trivially extend to federated learning using Flower or NVIDIA FLARE when DPDP Act enforcement requires on-device training. Architect now — deploy federated in 2027.

---

## 16. Failsafe — Error Handling & Conflict Resolution

### Conflict Resolution: Lexos vs LLM

| Confidence level | Decision |
|-----------------|---------|
| High ≥ INTENT_MATCH_THRESHOLD | Lexos wins. LLM receives enriched_context and acts on the resolved intent. |
| Medium 0.5 to threshold | Lexos suggests, LLM decides. Both signals passed as hint. |
| Low below 0.5 or null | LLM takes over. Lexos logs the miss. Never blocks the LLM call. |

### System-Level Failsafes

| Failure mode | What Lexos does | What the product experiences |
|-------------|----------------|------------------------------|
| Lexos service unreachable | SDK returns { intent: null, confidence: 0 } within 10ms timeout | LLM receives raw transcript only. Product degrades gracefully, never fails hard. |
| Both Lexos and LLM miss intent | Escalate to human via autonomy slider (Principle 9). In QSR: show the full menu. Log for review. | High-priority training data. |
| High conflict rate across calls | Do not suppress — this is a signal. Recalibrate INTENT_MATCH_THRESHOLD or address corpus gap. | IRAL harness catches this. |
| Reviewer promotes a wrong entry | Soft-delete + re-stage with rollback flag. Returns to review queue. audit_log retains full history. | Extra scrutiny applied on re-review. |
