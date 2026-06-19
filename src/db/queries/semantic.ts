import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// Semantic search queries (Step 4)
//
// Requires migration 002_vector_search_fn.sql to be deployed
// to Supabase before these functions will work.
// ──────────────────────────────────────────────────────────

export interface SemanticMatchResult {
  intent:     string;
  confidence: number;  // cosine similarity, 0–1
  term_id:    string;
}

export interface LogMissInput {
  utterance:   string;
  lang:        string | null;
  domain:      string;
  product_id?: string;
  tenant_id?:  string;
  user_id?:    string;
  workflow?:   string;
}

// ── Internal row returned by match_term_embeddings RPC ──

interface MatchRow {
  term_id:     string;
  intent_name: string;
  similarity:  number;
  priority:    number;
}

/**
 * Searches vector_embeddings using cosine similarity (HNSW index).
 * Delegates threshold and tenant filtering to the stored function
 * `match_term_embeddings` (migration 002).
 *
 * Returns the best match above INTENT_MATCH_THRESHOLD, or null.
 */
export async function semanticMatch(
  embedding: number[],
  lang:      string | null,   // null = search across all languages
  domain:    string,
  tenantId?: string,
  matchThreshold?: number,    // override the default floor (e.g. 0 for an OOD probe)
): Promise<SemanticMatchResult | null> {
  const db = getDb();

  // Dynamically import config to avoid circular deps at test time
  const { config } = await import('../../config');

  // Supabase JS sends arrays as JSON — Postgres won't auto-cast to vector.
  // Serialize as a string so Postgres receives it as a valid vector literal.
  const embeddingStr = `[${embedding.join(',')}]`;

  const { data, error } = await db.rpc('match_term_embeddings', {
    query_embedding: embeddingStr,
    match_threshold: matchThreshold ?? config.thresholds.intentMatch,
    match_count:     5,
    p_language_code: lang,
    p_domain:        domain,
    p_tenant_id:     tenantId ?? null,
  });

  if (error) throw new Error(`semanticMatch RPC: ${error.message}`);
  if (!data || (data as MatchRow[]).length === 0) return null;

  const best = (data as MatchRow[])[0];

  return {
    intent:     best.intent_name,
    confidence: best.similarity,
    term_id:    best.term_id,
  };
}

/**
 * Looks up the language of a term by id. Used to infer the language for the
 * classifier when the caller didn't supply one and detection returned null
 * (e.g. romanized Hindi/Marathi, which have no distinctive marker tokens).
 */
export async function getTermLanguage(termId: string): Promise<string | null> {
  const db = getDb();
  const { data, error } = await db
    .from('lexos_terms')
    .select('language_code')
    .eq('term_id', termId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { language_code: string }).language_code;
}

/**
 * Atomically upserts a miss record — increments frequency if seen before.
 * Uses the `upsert_miss` stored function (migration 002) to handle
 * NULL product_id / tenant_id safely across Postgres versions.
 *
 * Fire-and-forget — caller should NOT await this.
 * Errors are swallowed so miss logging never blocks the response.
 */
export async function logMiss(input: LogMissInput): Promise<void> {
  try {
    const db = getDb();
    await db.rpc('upsert_miss', {
      p_utterance:  input.utterance,
      p_lang:       input.lang,
      p_domain:     input.domain,
      p_product_id: input.product_id ?? null,
      p_tenant_id:  input.tenant_id  ?? null,
      p_user_id:    input.user_id    ?? null,
      p_workflow:   input.workflow   ?? null,
    });
  } catch (err) {
    // Never throw — miss logging must not block or fail the response
    console.warn('logMiss failed (non-fatal):', (err as Error).message);
  }
}
