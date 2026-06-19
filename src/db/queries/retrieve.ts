import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// Retrieve queries — vocabulary for ASR bias + LLM context
// ──────────────────────────────────────────────────────────

export interface PhoneticVariant {
  value:       string;
  confidence:  number;
  intent_name: string;
  tenant_id:   string | null;
}

interface VariantJoinRow {
  value:        string;
  confidence:   number | null;
  lexos_terms: {
    tenant_id:    string | null;
    product_id:   string | null;
    language_code: string;
    domain:       string;
    active:       boolean;
    valid_from:   string;
    valid_until:  string | null;
    lexos_intents: {
      intent_name: string;
    };
  };
}

/**
 * Returns all active PHONETIC variants for the given language + domain.
 *
 * Tenant layering (for ASR we want maximum coverage):
 *   - Returns both tenant-specific AND global variants
 *   - Deduplicates by value (tenant-specific wins if same phrase appears twice)
 *
 * @param workflow  Optional product_id filter (narrows to product-specific terms)
 */
export async function getPhoneticVariants(
  lang:       string,
  domain:     string,
  tenantId?:  string,
  workflow?:  string,
): Promise<PhoneticVariant[]> {
  const db  = getDb();
  const now = new Date();

  const { data, error } = await db
    .from('term_variants')
    .select(`
      value,
      confidence,
      lexos_terms!inner (
        tenant_id,
        product_id,
        language_code,
        domain,
        active,
        valid_from,
        valid_until,
        lexos_intents!inner (
          intent_name
        )
      )
    `)
    .eq('variant_type', 'PHONETIC');

  if (error) throw new Error(`getPhoneticVariants: ${error.message}`);

  // Filter in JS: language, domain, active, bi-temporal, tenant scope
  const rows = ((data ?? []) as unknown as VariantJoinRow[]).filter((row: VariantJoinRow) => {
    const t = row.lexos_terms;
    if (!t || !t.active) return false;
    if (t.language_code !== lang) return false;
    if (t.domain !== domain) return false;
    const from  = new Date(t.valid_from);
    const until = t.valid_until ? new Date(t.valid_until) : null;
    if (from > now) return false;
    if (until && until < now) return false;
    // Workflow maps to product_id — if specified, only include matching terms
    if (workflow && t.product_id && t.product_id !== workflow) return false;
    // Tenant scope: include tenant-specific (for given tenant) + global
    if (t.tenant_id && t.tenant_id !== tenantId) return false;
    return true;
  }) as VariantJoinRow[];

  // Deduplicate by value — tenant-specific phrase wins over global same phrase
  const seen   = new Map<string, PhoneticVariant>();
  // Sort so tenant-specific rows come first (they override global duplicates)
  const sorted = [...rows].sort((a, b) => {
    const aIsTenant = a.lexos_terms.tenant_id !== null ? 0 : 1;
    const bIsTenant = b.lexos_terms.tenant_id !== null ? 0 : 1;
    return aIsTenant - bIsTenant;
  });

  for (const row of sorted) {
    const key = row.value.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.set(key, {
        value:       row.value,
        confidence:  typeof row.confidence === 'number' ? row.confidence : 0.85,
        intent_name: row.lexos_terms.lexos_intents.intent_name,
        tenant_id:   row.lexos_terms.tenant_id,
      });
    }
  }

  return Array.from(seen.values());
}

// ──────────────────────────────────────────────────────────
// LLM context
// ──────────────────────────────────────────────────────────

export interface LlmContextEntry {
  intent:   string;
  tier:     string;
  phrases:  string[];   // COLLOQUIAL + CODE_MIXED, deduplicated
}

interface LlmVariantRow {
  variant_type: string;
  value:        string;
  lexos_terms: {
    tier:          string;
    tenant_id:     string | null;
    product_id:    string | null;
    language_code: string;
    domain:        string;
    active:        boolean;
    valid_from:    string;
    valid_until:   string | null;
    lexos_intents: {
      intent_name: string;
    };
  };
}

/**
 * Returns top-k intent entries with their COLLOQUIAL + CODE_MIXED phrases,
 * ordered by tier (A → B → C) for use in an LLM system prompt.
 *
 * Groups variants by intent so the LLM sees:
 *   { intent: "LEXOS_CART_ADD_ITEM", tier: "A", phrases: ["ek biryani do", ...] }
 */
export async function getLlmContextEntries(
  lang:      string,
  domain:    string,
  tenantId?: string,
  workflow?: string,
  k = 30,
): Promise<LlmContextEntry[]> {
  const db  = getDb();
  const now = new Date();

  const { data, error } = await db
    .from('term_variants')
    .select(`
      variant_type,
      value,
      lexos_terms!inner (
        tier,
        tenant_id,
        product_id,
        language_code,
        domain,
        active,
        valid_from,
        valid_until,
        lexos_intents!inner (
          intent_name
        )
      )
    `)
    .in('variant_type', ['COLLOQUIAL', 'CODE_MIXED']);

  if (error) throw new Error(`getLlmContextEntries: ${error.message}`);

  // Filter in JS: language, domain, active, bi-temporal, tenant + workflow scope
  const rows = ((data ?? []) as unknown as LlmVariantRow[]).filter((row: LlmVariantRow) => {
    const t = row.lexos_terms;
    if (!t || !t.active) return false;
    if (t.language_code !== lang) return false;
    if (t.domain !== domain) return false;
    const from  = new Date(t.valid_from);
    const until = t.valid_until ? new Date(t.valid_until) : null;
    if (from > now) return false;
    if (until && until < now) return false;
    if (workflow && t.product_id && t.product_id !== workflow) return false;
    if (t.tenant_id && t.tenant_id !== tenantId) return false;
    return true;
  }) as LlmVariantRow[];

  // Group by intent, collecting unique phrases
  const byIntent = new Map<string, { tier: string; phrases: Set<string> }>();

  for (const row of rows) {
    const intentName = row.lexos_terms.lexos_intents.intent_name;
    if (!byIntent.has(intentName)) {
      byIntent.set(intentName, { tier: row.lexos_terms.tier, phrases: new Set() });
    }
    byIntent.get(intentName)!.phrases.add(row.value);
  }

  // Sort A → B → C, then alphabetically within tier
  const TIER_ORDER: Record<string, number> = { A: 0, B: 1, C: 2 };
  const entries: LlmContextEntry[] = Array.from(byIntent.entries())
    .map(([intent, { tier, phrases }]) => ({
      intent,
      tier,
      phrases: Array.from(phrases),
    }))
    .sort((a, b) => {
      const tierDiff = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
      return tierDiff !== 0 ? tierDiff : a.intent.localeCompare(b.intent);
    })
    .slice(0, k);

  return entries;
}
