-- ══════════════════════════════════════════════════════════
-- LEXOS — MIGRATION 002
-- Paste into Supabase SQL editor and run.
--
-- Adds:
--   1. match_term_embeddings()  — HNSW cosine-similarity search
--   2. upsert_miss()            — atomic frequency-incrementing miss log
-- ══════════════════════════════════════════════════════════

-- ── 1. Vector similarity search ────────────────────────────
-- Called by the semantic path in POST /enrich.
-- Returns terms whose embedding cosine-similarity to
-- query_embedding is >= match_threshold, ordered by similarity.
--
-- Tenant layering applied inside the query:
--   tenant-specific term ranked first via priority column.

-- query_embedding passed as text ('[0.1,0.2,...]') so PostgREST can handle it.
-- Cast to vector(768) happens inside the function where pgvector is available.
CREATE OR REPLACE FUNCTION match_term_embeddings(
  query_embedding  text,
  match_threshold  float,
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
LANGUAGE plpgsql
AS $$
DECLARE
  v_embedding vector(768);
BEGIN
  v_embedding := query_embedding::vector(768);

  RETURN QUERY
  SELECT
    lt.term_id,
    li.intent_name,
    (1 - (ve.embedding <=> v_embedding))::float8 AS similarity,
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
    AND (1 - (ve.embedding <=> v_embedding)) >= match_threshold
  ORDER BY
    priority ASC,
    ve.embedding <=> v_embedding ASC
  LIMIT match_count;
END;
$$;


-- ── 2. Atomic miss upsert ──────────────────────────────────
-- Inserts a new miss row or increments frequency if seen before.
-- Handles NULL product_id / tenant_id safely (Postgres treats
-- two NULLs as distinct in a standard UNIQUE INDEX, so we use
-- an explicit SELECT + INSERT/UPDATE instead of ON CONFLICT).

CREATE OR REPLACE FUNCTION upsert_miss(
  p_utterance   text,
  p_lang        text,
  p_domain      text,
  p_product_id  text,
  p_tenant_id   text,
  p_user_id     text,
  p_workflow    text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_miss_id uuid;
BEGIN
  -- Find existing row, comparing NULLs explicitly
  SELECT miss_id INTO v_miss_id
  FROM   lexos_misses
  WHERE  utterance  = p_utterance
    AND  lang       = p_lang
    AND  domain     = p_domain
    AND  (product_id = p_product_id OR (product_id IS NULL AND p_product_id IS NULL))
    AND  (tenant_id  = p_tenant_id  OR (tenant_id  IS NULL AND p_tenant_id  IS NULL))
  LIMIT 1;

  IF v_miss_id IS NOT NULL THEN
    UPDATE lexos_misses
    SET    frequency = frequency + 1,
           last_seen = NOW(),
           user_id   = COALESCE(p_user_id,  user_id),
           workflow  = COALESCE(p_workflow, workflow)
    WHERE  miss_id = v_miss_id;
  ELSE
    INSERT INTO lexos_misses
      (utterance, lang, domain, product_id, tenant_id, user_id, workflow, frequency, first_seen, last_seen)
    VALUES
      (p_utterance, p_lang, p_domain, p_product_id, p_tenant_id, p_user_id, p_workflow, 1, NOW(), NOW());
  END IF;
END;
$$;
