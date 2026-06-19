-- ══════════════════════════════════════════════════════════
-- LEXOS — MIGRATION 007
-- Make language filter optional in match_term_embeddings.
--
-- When p_language_code is NULL, the language filter is skipped
-- and the search runs across all languages (global corpus).
-- This enables automatic language detection in /enrich —
-- callers no longer need to pass lang explicitly.
-- ══════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS match_term_embeddings(text, float8, int, text, text, text);
DROP FUNCTION IF EXISTS match_term_embeddings(text, double precision, integer, text, text, text);

CREATE OR REPLACE FUNCTION match_term_embeddings(
  query_embedding  text,
  match_threshold  float8,
  match_count      int,
  p_language_code  text DEFAULT NULL,   -- NULL = search all languages
  p_domain         text DEFAULT 'restaurant',
  p_tenant_id      text DEFAULT NULL
)
RETURNS TABLE (
  term_id      uuid,
  intent_name  text,
  similarity   float8,
  priority     int
)
LANGUAGE sql
AS $$
  SELECT
    lt.term_id,
    li.intent_name,
    (1 - (ve.embedding <=> query_embedding::vector(1024)))::float8 AS similarity,
    CASE WHEN lt.tenant_id IS NOT NULL THEN 0 ELSE 1 END AS priority
  FROM
    vector_embeddings ve
    JOIN lexos_terms    lt ON lt.term_id   = ve.term_id
    JOIN lexos_intents  li ON li.intent_id = lt.intent_id
  WHERE
    lt.active = true
    AND (p_language_code IS NULL OR lt.language_code = p_language_code)
    AND lt.domain = p_domain
    AND NOW() BETWEEN lt.valid_from AND COALESCE(lt.valid_until, 'infinity'::timestamp)
    AND (
      lt.tenant_id IS NULL
      OR (p_tenant_id IS NOT NULL AND lt.tenant_id = p_tenant_id)
    )
    AND (1 - (ve.embedding <=> query_embedding::vector(1024))) >= match_threshold
  ORDER BY
    priority ASC,
    ve.embedding <=> query_embedding::vector(1024) ASC
  LIMIT match_count;
$$;

NOTIFY pgrst, 'reload schema';
