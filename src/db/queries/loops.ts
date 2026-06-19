import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// DB queries for the miss loop and semantic promote loop
// ──────────────────────────────────────────────────────────

export interface QualifiedMiss {
  miss_id:    string;
  utterance:  string;
  lang:       string;
  domain:     string | null;
  product_id: string | null;
  tenant_id:  string | null;
  workflow:   string | null;
  frequency:  number;
}

/**
 * Returns unprocessed misses at or above the frequency threshold,
 * ordered by frequency descending.
 * Limited to `limit` rows per call (default 50).
 */
export async function getQualifiedMisses(
  threshold: number,
  lang?:     string,
  limit = 50,
): Promise<QualifiedMiss[]> {
  const db = getDb();

  let query = db
    .from('lexos_misses')
    .select('miss_id, utterance, lang, domain, product_id, tenant_id, workflow, frequency')
    .gte('frequency', threshold)
    .is('processed_at', null)
    .order('frequency', { ascending: false })
    .limit(limit);

  if (lang) {
    query = query.eq('lang', lang);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getQualifiedMisses: ${error.message}`);
  return (data ?? []) as QualifiedMiss[];
}

/**
 * Marks a batch of misses as processed so the loop doesn't re-process them.
 */
export async function markMissesProcessed(missIds: string[]): Promise<void> {
  if (missIds.length === 0) return;
  const db = getDb();
  const { error } = await db
    .from('lexos_misses')
    .update({ processed_at: new Date().toISOString() })
    .in('miss_id', missIds);

  if (error) throw new Error(`markMissesProcessed: ${error.message}`);
}

// ──────────────────────────────────────────────────────────

export interface QualifiedSemanticHit {
  input_phrase:   string;
  matched_intent: string;
  lang:           string;
  frequency:      number;
  tenant_id:      string | null;
}

/**
 * Returns semantic hits that have been confirmed correct (downstream_outcome='correct')
 * and have reached the promotion threshold.
 * Groups by (input_phrase, matched_intent, lang, tenant_id) and counts occurrences.
 */
export async function getQualifiedSemanticHits(
  threshold: number,
  lang?:     string,
  limit = 50,
): Promise<QualifiedSemanticHit[]> {
  const db = getDb();

  // Fetch raw rows — aggregate in JS (Supabase JS doesn't expose GROUP BY directly)
  let query = db
    .from('lexos_enrich_calls')
    .select('input_phrase, matched_intent, lang, tenant_id')
    .eq('match_type', 'semantic')
    .eq('downstream_outcome', 'correct')
    .not('matched_intent', 'is', null);

  if (lang) {
    query = query.eq('lang', lang);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getQualifiedSemanticHits: ${error.message}`);

  // Group + count in JS
  const counts = new Map<string, QualifiedSemanticHit>();
  for (const row of (data ?? []) as {
    input_phrase: string;
    matched_intent: string;
    lang: string;
    tenant_id: string | null;
  }[]) {
    const key = `${row.input_phrase}|${row.matched_intent}|${row.lang}|${row.tenant_id ?? ''}`;
    const existing = counts.get(key);
    if (existing) {
      existing.frequency++;
    } else {
      counts.set(key, {
        input_phrase:   row.input_phrase,
        matched_intent: row.matched_intent,
        lang:           row.lang,
        tenant_id:      row.tenant_id,
        frequency:      1,
      });
    }
  }

  return Array.from(counts.values())
    .filter(h => h.frequency >= threshold)
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, limit);
}
