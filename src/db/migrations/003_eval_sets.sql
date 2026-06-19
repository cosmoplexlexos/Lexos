-- ══════════════════════════════════════════════════════════
-- LEXOS — MIGRATION 003
-- Paste into Supabase SQL editor and run.
--
-- Adds:
--   eval_sets — IRAL v0 ground-truth phrase→intent pairs
-- ══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS eval_sets (
  eval_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  language_code  VARCHAR(10)  NOT NULL,
  phrase         TEXT         NOT NULL,
  correct_intent VARCHAR(100) NOT NULL,  -- LEXOS_* key (intent_name, not UUID)
  variant_type   VARCHAR(20),            -- COLLOQUIAL | CODE_MIXED | PHONETIC | FORMAL
  created_at     TIMESTAMP DEFAULT NOW()
);

-- Primary lookup: all eval pairs for a language (used by IRAL check)
CREATE INDEX idx_eval_sets_lang ON eval_sets(language_code);

-- Secondary lookup: eval pairs for a specific intent + language
CREATE INDEX idx_eval_sets_lang_intent ON eval_sets(language_code, correct_intent);

-- Prevent duplicate (phrase, language) entries from double-loads
CREATE UNIQUE INDEX idx_eval_sets_phrase_lang
  ON eval_sets(language_code, phrase);
