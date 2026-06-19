-- ══════════════════════════════════════════════════════════
-- LEXOS — MIGRATION 006
-- Switch from bge-base-en-v1.5 (768d) to bge-m3 (1024d)
-- for multilingual semantic search.
--
-- Steps:
--   1. Drop old HNSW index and vector_embeddings table
--   2. Recreate vector_embeddings with vector(1024)
--   3. Recreate HNSW index
--   4. Drop and recreate match_term_embeddings for vector(1024)
-- ══════════════════════════════════════════════════════════

-- 1. Drop old embeddings (stale 768-dim data — will be backfilled after)
DROP INDEX  IF EXISTS idx_vector_embeddings_hnsw;
TRUNCATE TABLE vector_embeddings;
ALTER TABLE vector_embeddings ALTER COLUMN embedding TYPE vector(1024);
ALTER TABLE vector_embeddings ALTER COLUMN embedding SET STORAGE PLAIN;

-- 2. Recreate HNSW index for 1024 dimensions
CREATE INDEX idx_vector_embeddings_hnsw
  ON vector_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 128);

-- 3. Replace the search function for 1024-dim vectors
DROP FUNCTION IF EXISTS match_term_embeddings(text, float, int, text, text, text);
DROP FUNCTION IF EXISTS match_term_embeddings(text, double precision, integer, text, text, text);

CREATE OR REPLACE FUNCTION match_term_embeddings(
  query_embedding  text,
  match_threshold  float8,
  match_count      int,
  p_language_code  text,
  p_domain         text,
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
    lt.active          = true
    AND lt.language_code = p_language_code
    AND lt.domain        = p_domain
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
