import { getDb } from '../client';
import { GeneratedVariant, Tier } from '../../types';

// ──────────────────────────────────────────────────────────
// lexos_terms + term_variants queries
// ──────────────────────────────────────────────────────────

export interface CreateTermInput {
  intent_id: string;      // UUID
  language_code: string;
  domain: string;
  tier: Tier;
}

/**
 * Checks whether an active term already exists for this intent × language.
 * Used for idempotent re-runs.
 */
export async function termExists(
  intentUuid: string,
  languageCode: string,
): Promise<string | null> {
  const db = getDb();
  const { data, error } = await db
    .from('lexos_terms')
    .select('term_id')
    .eq('intent_id', intentUuid)
    .eq('language_code', languageCode)
    .eq('active', true)
    .limit(1);

  if (error) throw new Error(`termExists: ${error.message}`);
  return data && data.length > 0 ? (data[0] as { term_id: string }).term_id : null;
}

/**
 * Inserts a new lexos_terms row.
 * Returns the generated term_id UUID.
 */
export async function createTerm(input: CreateTermInput): Promise<string> {
  const db = getDb();
  const { data, error } = await db
    .from('lexos_terms')
    .insert({
      intent_id:     input.intent_id,
      language_code: input.language_code,
      domain:        input.domain,
      tier:          input.tier,
      active:        true,
    })
    .select('term_id')
    .single();

  if (error) throw new Error(`createTerm: ${error.message}`);
  return (data as { term_id: string }).term_id;
}

/**
 * Bulk-inserts all variants for a term.
 */
export async function createVariants(
  termId: string,
  variants: GeneratedVariant[],
): Promise<void> {
  const db = getDb();
  const rows = variants.map(v => ({
    term_id:      termId,
    variant_type: v.type,
    value:        v.value,
    confidence:   v.confidence,
  }));

  const { error } = await db.from('term_variants').insert(rows);
  if (error) throw new Error(`createVariants: ${error.message}`);
}

/** Returns all active terms for a given language + domain. */
export async function getActiveTerms(
  languageCode: string,
  domain: string,
  tenantId?: string,
): Promise<{ term_id: string; intent_id: string }[]> {
  const db = getDb();

  let query = db
    .from('lexos_terms')
    .select('term_id, intent_id')
    .eq('language_code', languageCode)
    .eq('domain', domain)
    .eq('active', true)
    .lte('valid_from', new Date().toISOString())
    .or('valid_until.is.null,valid_until.gte.' + new Date().toISOString());

  if (tenantId) {
    query = query.or(`tenant_id.eq.${tenantId},tenant_id.is.null`);
  } else {
    query = query.is('tenant_id', null);
  }

  const { data, error } = await query;
  if (error) throw new Error(`getActiveTerms: ${error.message}`);
  return (data ?? []) as { term_id: string; intent_id: string }[];
}
