import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// Lightweight read queries for the demo UI live-log panels
// ──────────────────────────────────────────────────────────

export interface RecentMiss {
  miss_id:   string;
  utterance: string;
  lang:      string;
  frequency: number;
  last_seen: string;
  workflow:  string | null;
}

export async function getRecentMisses(opts: {
  lang?:     string;
  workflow?: string;
  limit?:    number;
}): Promise<RecentMiss[]> {
  const db = getDb();

  let query = db
    .from('lexos_misses')
    .select('miss_id, utterance, lang, frequency, last_seen, workflow')
    .order('last_seen', { ascending: false })
    .limit(opts.limit ?? 20);

  if (opts.lang)     query = query.eq('lang', opts.lang);
  if (opts.workflow) query = query.eq('workflow', opts.workflow);

  const { data, error } = await query;
  if (error) throw new Error(`getRecentMisses: ${error.message}`);
  return (data ?? []) as RecentMiss[];
}

export interface RecentSemanticHit {
  call_id:        string;
  input_phrase:   string;
  matched_intent: string | null;
  lang:           string | null;
  latency_ms:     number | null;
  timestamp:      string;
}

export async function getRecentSemanticHits(opts: {
  lang?:     string;
  workflow?: string;
  limit?:    number;
}): Promise<RecentSemanticHit[]> {
  const db = getDb();

  let query = db
    .from('lexos_enrich_calls')
    .select('call_id, input_phrase, matched_intent, lang, latency_ms, timestamp')
    .eq('match_type', 'semantic')
    .order('timestamp', { ascending: false })
    .limit(opts.limit ?? 20);

  if (opts.lang)     query = query.eq('lang', opts.lang);
  if (opts.workflow) query = query.eq('workflow', opts.workflow);

  const { data, error } = await query;
  if (error) throw new Error(`getRecentSemanticHits: ${error.message}`);
  return (data ?? []) as RecentSemanticHit[];
}
