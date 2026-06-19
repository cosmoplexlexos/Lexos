# Lexos — Database Schema

Run this migration before writing any application code.
Run ALTER TABLE ... SET STORAGE PLAIN before inserting any vector data.

```sql
-- ══════════════════════════════════════════════════════════
-- LEXOS — INITIAL MIGRATION
-- Run against a clean Supabase Postgres instance
-- ══════════════════════════════════════════════════════════

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- ── lexos_intents ──────────────────────────────────────────
CREATE TABLE lexos_intents (
  intent_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_name     VARCHAR(100) NOT NULL,
  domain          VARCHAR(50)  NOT NULL,
  product_id      VARCHAR(50),           -- NULL = global
  created_at      TIMESTAMP DEFAULT NOW()
);

-- ── lexos_terms ────────────────────────────────────────────
CREATE TABLE lexos_terms (
  term_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id        UUID REFERENCES lexos_intents(intent_id),
  language_code    VARCHAR(10)  NOT NULL,
  domain           VARCHAR(50)  NOT NULL,
  tier             CHAR(1)      CHECK (tier IN ('A','B','C')),
  product_id       VARCHAR(50),           -- NULL = global
  tenant_id        VARCHAR(50),           -- NULL = shared across all tenants
  active           BOOLEAN      DEFAULT true,
  -- Bi-temporal validity
  valid_from       TIMESTAMP    DEFAULT NOW(),
  valid_until      TIMESTAMP,             -- NULL = currently valid
  superseded_by    UUID,                  -- FK to replacement term_id
  -- Usage analytics
  hit_count        BIGINT       DEFAULT 0,
  last_hit_at      TIMESTAMP,
  success_after_hit BIGINT      DEFAULT 0,
  miss_after_hit   BIGINT       DEFAULT 0,
  created_at       TIMESTAMP    DEFAULT NOW()
);

CREATE INDEX idx_lexos_terms_intent    ON lexos_terms(intent_id);
CREATE INDEX idx_lexos_terms_lang      ON lexos_terms(language_code);
CREATE INDEX idx_lexos_terms_tenant    ON lexos_terms(tenant_id);
CREATE INDEX idx_lexos_terms_active    ON lexos_terms(active) WHERE active = true;

-- ── term_variants ──────────────────────────────────────────
CREATE TABLE term_variants (
  variant_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id      UUID REFERENCES lexos_terms(term_id),
  variant_type VARCHAR(20) CHECK (variant_type IN ('FORMAL','COLLOQUIAL','CODE_MIXED','PHONETIC')),
  value        TEXT        NOT NULL,
  confidence   NUMERIC(3,2) CHECK (confidence BETWEEN 0.0 AND 1.0),
  created_at   TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_term_variants_term     ON term_variants(term_id);
CREATE INDEX idx_term_variants_type_val ON term_variants(variant_type, value);

-- ── vector_embeddings ──────────────────────────────────────
CREATE TABLE vector_embeddings (
  embedding_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id       UUID REFERENCES lexos_terms(term_id),
  embedding     vector(1024),   -- bge-m3 dimension (migration 006 changed from 768)
  model_version VARCHAR(64)  NOT NULL,
  model_name    VARCHAR(128) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- CRITICAL: run this before inserting any vector data
-- Prevents TOAST from pushing vectors to secondary storage (makes search catastrophically slow)
ALTER TABLE vector_embeddings ALTER COLUMN embedding SET STORAGE PLAIN;

-- HNSW index for fast approximate nearest-neighbour search
CREATE INDEX idx_vector_embeddings_hnsw
  ON vector_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- ── lexos_entries_staging ──────────────────────────────────
CREATE TABLE lexos_entries_staging (
  staging_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- mirrors lexos_terms columns
  intent_id      UUID REFERENCES lexos_intents(intent_id),
  language_code  VARCHAR(10),
  domain         VARCHAR(50),
  tier           CHAR(1),
  product_id     VARCHAR(50),
  tenant_id      VARCHAR(50),
  -- staging-specific
  status         VARCHAR(20) DEFAULT 'AI_DRAFT' CHECK (status IN ('AI_DRAFT','APPROVED','REJECTED')),
  rollback_of    UUID,                   -- FK to original term_id if this is a rollback
  eval_passed    BOOLEAN,
  eval_regression BOOLEAN,
  reviewer_id    VARCHAR(100),
  reviewed_at    TIMESTAMP,
  created_at     TIMESTAMP DEFAULT NOW()
);

-- ── lexos_misses ───────────────────────────────────────────
CREATE TABLE lexos_misses (
  miss_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utterance   TEXT        NOT NULL,
  lang        VARCHAR(10) NOT NULL,
  domain      VARCHAR(50),
  product_id  VARCHAR(50),
  tenant_id   VARCHAR(50),
  user_id     VARCHAR(50),
  workflow    VARCHAR(100),
  frequency   INT         DEFAULT 1,
  first_seen  TIMESTAMP   DEFAULT NOW(),
  last_seen   TIMESTAMP   DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_misses_utterance_tenant
  ON lexos_misses(utterance, lang, domain, product_id, tenant_id);

-- ── lexos_enrich_calls ─────────────────────────────────────
CREATE TABLE lexos_enrich_calls (
  call_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp          TIMESTAMP   DEFAULT NOW(),
  input_phrase       TEXT        NOT NULL,
  matched_intent     VARCHAR(100),        -- NULL if miss
  match_type         VARCHAR(20) CHECK (match_type IN ('exact','semantic','miss')),
  latency_ms         INT,
  downstream_outcome VARCHAR(20) CHECK (downstream_outcome IN ('correct','incorrect','abandoned','unknown')),
  product_id         VARCHAR(50),
  tenant_id          VARCHAR(50),
  user_id            VARCHAR(50),
  workflow           VARCHAR(100),
  lang               VARCHAR(10)
);

CREATE INDEX idx_enrich_calls_intent   ON lexos_enrich_calls(matched_intent);
CREATE INDEX idx_enrich_calls_type     ON lexos_enrich_calls(match_type);
CREATE INDEX idx_enrich_calls_tenant   ON lexos_enrich_calls(tenant_id);
CREATE INDEX idx_enrich_calls_ts       ON lexos_enrich_calls(timestamp);

-- ── audit_log ──────────────────────────────────────────────
-- Append-only. Never UPDATE or DELETE rows from this table.
CREATE TABLE audit_log (
  audit_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_id       UUID REFERENCES lexos_terms(term_id),
  field_changed VARCHAR(100),
  old_value     TEXT,
  new_value     TEXT,
  editor        VARCHAR(100),
  timestamp     TIMESTAMP DEFAULT NOW()
);

-- ── tenant_profiles ────────────────────────────────────────
CREATE TABLE tenant_profiles (
  tenant_id            VARCHAR(50) PRIMARY KEY,
  tenant_type          VARCHAR(20) CHECK (tenant_type IN ('business','user')),
  primary_language     VARCHAR(10),
  geographic_region    VARCHAR(100),
  register_preference  VARCHAR(20) CHECK (register_preference IN ('formal','colloquial','mixed')),
  customer_demographic JSONB,            -- age range, tech familiarity, literacy profile
  seed_vocabulary      JSONB,            -- menu items, location names, brand-specific terms
  configured_at        TIMESTAMP DEFAULT NOW(),
  last_updated         TIMESTAMP DEFAULT NOW()
);

-- ── user_profiles ──────────────────────────────────────────
CREATE TABLE user_profiles (
  user_id              VARCHAR(50) PRIMARY KEY,
  native_language      VARCHAR(10),      -- inferred from phrase patterns
  geographic_region    VARCHAR(100),     -- inferred from utterances
  explicit_preferences JSONB,            -- user-set overrides
  learned_patterns     JSONB,            -- system-observed vocabulary patterns
  interaction_count    INT DEFAULT 0,
  last_updated         TIMESTAMP DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════
-- SDK QUERY FILTER (use this pattern everywhere)
-- Only return currently valid entries for the given tenant
-- ══════════════════════════════════════════════════════════
-- WHERE active = true
-- AND NOW() BETWEEN valid_from AND COALESCE(valid_until, 'infinity')
-- AND (product_id = $product_id OR product_id IS NULL)
-- AND (tenant_id = $tenant_id OR tenant_id IS NULL)
```

## Notes (2026-06)

- **`vector_embeddings` is now an out-of-domain gate, not the intent decision.**
  Intent resolution uses a trained classifier (`src/classifier/model.json`), not
  nearest-neighbour over these centroids. The embeddings are still queried (via
  `match_term_embeddings`) only to answer "is this phrase near any known
  vocabulary?". The classifier model is a **file artifact, not a DB table** —
  retrain with `scripts/train-intent-classifier.ts` after vocabulary changes.
  See `docs/ARCHITECTURE.md` §7 and `.claude/rules/decisions.md`.
- **One embedding per term** (built from its concatenated COLLOQUIAL variants),
  not one per variant. Inserts/edits regenerate it (`scripts/insert-supplement-phrases.ts`).
- **Disabling a language** sets `lexos_terms.active = false` AND deletes its rows
  from `vector_embeddings` (removed from the HNSW index entirely, not just
  filtered). Re-enabling regenerates them. See `scripts/toggle-languages.ts`.
- `match_term_embeddings` filters `lt.active = true`, so inactive languages never
  appear in semantic results. Migration `007_lang_optional_search.sql` made the
  language filter optional (NULL = search all).
