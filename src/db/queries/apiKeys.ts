import { createHash, randomBytes } from 'crypto';
import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// Per-tenant API keys. Plaintext is shown once at creation; only the
// SHA-256 hash is stored. /enrich + /retrieve resolve the tenant from the key.
// ──────────────────────────────────────────────────────────

export interface ApiKeyRow {
  key_id:       string;
  tenant_id:    string;
  product_id:   string | null;
  key_prefix:   string;
  label:        string | null;
  active:       boolean;
  created_at:   string;
  last_used_at: string | null;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Generates a new key, stores its hash, returns the plaintext ONCE. */
export async function createApiKey(
  tenantId: string,
  opts: { product_id?: string; label?: string } = {},
): Promise<{ key: string; key_id: string; key_prefix: string }> {
  const key = 'lx_' + randomBytes(24).toString('hex'); // lx_ + 48 hex chars
  const key_prefix = key.slice(0, 12);
  const db = getDb();
  const { data, error } = await db
    .from('api_keys')
    .insert({
      tenant_id:  tenantId,
      product_id: opts.product_id ?? null,
      key_hash:   hashKey(key),
      key_prefix,
      label:      opts.label ?? null,
    })
    .select('key_id')
    .single();
  if (error) throw new Error(`createApiKey: ${error.message}`);
  return { key, key_id: (data as { key_id: string }).key_id, key_prefix };
}

/** Validates a plaintext key. Returns the owning tenant, or null. */
export async function validateApiKey(key: string): Promise<{ tenant_id: string; product_id: string | null } | null> {
  const db = getDb();
  const { data, error } = await db
    .from('api_keys')
    .select('key_id, tenant_id, product_id')
    .eq('key_hash', hashKey(key))
    .eq('active', true)
    .maybeSingle();
  if (error || !data) return null;
  // fire-and-forget last_used_at
  db.from('api_keys').update({ last_used_at: new Date().toISOString() })
    .eq('key_id', (data as { key_id: string }).key_id).then(() => {}, () => {});
  return { tenant_id: (data as any).tenant_id, product_id: (data as any).product_id };
}

export async function listApiKeys(tenantId: string): Promise<ApiKeyRow[]> {
  const db = getDb();
  const { data, error } = await db
    .from('api_keys')
    .select('key_id, tenant_id, product_id, key_prefix, label, active, created_at, last_used_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`listApiKeys: ${error.message}`);
  return (data ?? []) as ApiKeyRow[];
}

export async function revokeApiKey(keyId: string): Promise<void> {
  const db = getDb();
  const { error } = await db.from('api_keys').update({ active: false }).eq('key_id', keyId);
  if (error) throw new Error(`revokeApiKey: ${error.message}`);
}
