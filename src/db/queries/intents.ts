import { getDb } from '../client';
import { QsrIntent } from '../../types';

// ──────────────────────────────────────────────────────────
// lexos_intents queries
// ──────────────────────────────────────────────────────────

export interface DbIntent {
  intent_id: string;    // UUID
  intent_name: string;  // stores the LEXOS_* key
  domain: string;
  product_id: string | null;
}

/**
 * Seeds lexos_intents from qsr-intents.json.
 * Idempotent — skips intents that already exist by intent_name.
 * Returns a map of intent_name → UUID.
 */
export async function seedIntents(
  intents: QsrIntent[],
): Promise<Map<string, string>> {
  const db = getDb();

  // 1. Fetch existing
  const { data: existing, error: fetchErr } = await db
    .from('lexos_intents')
    .select('intent_id, intent_name');

  if (fetchErr) throw new Error(`seedIntents fetch: ${fetchErr.message}`);

  const nameToUuid = new Map<string, string>(
    (existing ?? []).map((r: { intent_id: string; intent_name: string }) => [r.intent_name, r.intent_id]),
  );

  // 2. Insert only missing ones
  const toInsert = intents
    .filter(i => !nameToUuid.has(i.intent_id))
    .map(i => ({
      intent_name: i.intent_id,   // store the LEXOS_* key as intent_name
      domain:      i.domain,
      product_id:  null,
    }));

  if (toInsert.length > 0) {
    const { data: inserted, error: insertErr } = await db
      .from('lexos_intents')
      .insert(toInsert)
      .select('intent_id, intent_name');

    if (insertErr) throw new Error(`seedIntents insert: ${insertErr.message}`);

    for (const row of (inserted ?? []) as DbIntent[]) {
      nameToUuid.set(row.intent_name, row.intent_id);
    }
  }

  return nameToUuid;
}

/** Returns all global intents as a name→UUID map. */
export async function getIntentMap(): Promise<Map<string, string>> {
  const db = getDb();
  const { data, error } = await db
    .from('lexos_intents')
    .select('intent_id, intent_name')
    .is('product_id', null);

  if (error) throw new Error(`getIntentMap: ${error.message}`);

  return new Map(
    (data ?? []).map((r: { intent_id: string; intent_name: string }) => [r.intent_name, r.intent_id]),
  );
}
