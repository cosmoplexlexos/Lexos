import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// tenant_profiles queries
// ──────────────────────────────────────────────────────────

export interface TenantProfile {
  tenant_id:            string;
  display_name:         string | null;
  tenant_type:          'business' | 'user' | null;
  primary_language:     string | null;
  geographic_region:    string | null;
  register_preference:  'formal' | 'colloquial' | 'mixed' | null;
  customer_demographic: Record<string, unknown> | null;
  seed_vocabulary:      Record<string, unknown> | null;
  configured_at:        string;
  last_updated:         string;
}

export interface UpsertTenantInput {
  tenant_id:            string;
  display_name?:        string;
  tenant_type?:         'business' | 'user';
  primary_language?:    string;
  geographic_region?:   string;
  register_preference?: 'formal' | 'colloquial' | 'mixed';
  customer_demographic?: Record<string, unknown>;
  seed_vocabulary?:     Record<string, unknown>;
}

/**
 * Creates or updates a tenant profile.
 * All fields except tenant_id are optional — only provided fields are updated.
 */
export async function upsertTenantProfile(input: UpsertTenantInput): Promise<TenantProfile> {
  const db = getDb();

  const payload: Record<string, unknown> = {
    tenant_id:    input.tenant_id,
    last_updated: new Date().toISOString(),
  };

  if (input.display_name         !== undefined) payload.display_name         = input.display_name;
  if (input.tenant_type          !== undefined) payload.tenant_type          = input.tenant_type;
  if (input.primary_language     !== undefined) payload.primary_language     = input.primary_language;
  if (input.geographic_region    !== undefined) payload.geographic_region    = input.geographic_region;
  if (input.register_preference  !== undefined) payload.register_preference  = input.register_preference;
  if (input.customer_demographic !== undefined) payload.customer_demographic = input.customer_demographic;
  if (input.seed_vocabulary      !== undefined) payload.seed_vocabulary      = input.seed_vocabulary;

  const { data, error } = await db
    .from('tenant_profiles')
    .upsert(payload, { onConflict: 'tenant_id' })
    .select()
    .single();

  if (error) throw new Error(`upsertTenantProfile: ${error.message}`);
  return data as TenantProfile;
}

/** Lists all tenant profiles (admin dashboard). */
export async function listTenantProfiles(): Promise<TenantProfile[]> {
  const db = getDb();
  const { data, error } = await db
    .from('tenant_profiles')
    .select('*')
    .order('configured_at', { ascending: false });
  if (error) throw new Error(`listTenantProfiles: ${error.message}`);
  return (data ?? []) as TenantProfile[];
}

/** Returns a tenant profile or null if not found. */
export async function getTenantProfile(tenantId: string): Promise<TenantProfile | null> {
  const db = getDb();
  const { data, error } = await db
    .from('tenant_profiles')
    .select('*')
    .eq('tenant_id', tenantId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`getTenantProfile: ${error.message}`);
  }
  return data as TenantProfile;
}

/**
 * Merges new vocabulary items into an existing tenant's seed_vocabulary.
 * seed_vocabulary is a JSONB object: { items: string[] }
 */
export async function mergeTenantVocabulary(
  tenantId:  string,
  newItems:  string[],
): Promise<void> {
  const db = getDb();

  // Fetch current vocabulary
  const current = await getTenantProfile(tenantId);
  const existing = (current?.seed_vocabulary?.items as string[] | undefined) ?? [];

  // Merge and deduplicate
  const merged = Array.from(new Set([...existing, ...newItems]));

  const { error } = await db
    .from('tenant_profiles')
    .upsert(
      {
        tenant_id:      tenantId,
        seed_vocabulary: { items: merged },
        last_updated:   new Date().toISOString(),
      },
      { onConflict: 'tenant_id' },
    );

  if (error) throw new Error(`mergeTenantVocabulary: ${error.message}`);
}
