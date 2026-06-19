import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// Per-tenant menu items + their embeddings.
// ──────────────────────────────────────────────────────────

export interface MenuItemInput {
  name:      string;
  category?: string | null;
  price?:    number | null;
  embedding: number[];
}

export interface MenuItemVec {
  name:      string;
  embedding: number[];
}

/** Replaces a tenant's entire menu (delete + insert) in one logical update. */
export async function replaceTenantMenu(
  tenantId: string,
  items: MenuItemInput[],
  modelName: string,
): Promise<number> {
  const db = getDb();
  const { error: delErr } = await db.from('menu_items').delete().eq('tenant_id', tenantId);
  if (delErr) throw new Error(`replaceTenantMenu(delete): ${delErr.message}`);

  if (items.length === 0) return 0;
  const rows = items.map(it => ({
    tenant_id:  tenantId,
    name:       it.name,
    category:   it.category ?? null,
    price:      it.price ?? null,
    embedding:  `[${it.embedding.join(',')}]`,
    model_name: modelName,
  }));
  // Chunk — each row carries a 1024-dim vector, so the payload is large.
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error: insErr } = await db.from('menu_items').insert(rows.slice(i, i + CHUNK));
    if (insErr) throw new Error(`replaceTenantMenu(insert): ${insErr.message}`);
  }
  return rows.length;
}

/** Loads a tenant's items with parsed embeddings (for in-process matching). */
export async function getTenantMenuItems(tenantId: string): Promise<MenuItemVec[]> {
  const db = getDb();
  const { data, error } = await db
    .from('menu_items')
    .select('name, embedding')
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`getTenantMenuItems: ${error.message}`);
  return (data ?? []).map((r: any) => ({
    name: r.name,
    // pgvector returns the vector as a "[..]" string — valid JSON.
    embedding: typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding,
  }));
}

export interface MenuForm { name: string; tokens: string[]; }

/** Stores per-surface-form tokens (menu_forms, for lexical span matching) and
 *  their union (menu_tokens, for the unknown-content gate) in seed_vocabulary.
 *  Merges — preserves other seed_vocabulary keys. */
export async function setTenantMenuMeta(tenantId: string, forms: MenuForm[]): Promise<void> {
  const db = getDb();
  const { data } = await db.from('tenant_profiles').select('seed_vocabulary').eq('tenant_id', tenantId).maybeSingle();
  const sv = ((data as any)?.seed_vocabulary as Record<string, unknown>) ?? {};
  const union = new Set<string>();
  for (const f of forms) for (const t of f.tokens) union.add(t);
  sv.menu_forms  = forms.map(f => ({ n: f.name, t: f.tokens }));   // compact keys
  sv.menu_tokens = Array.from(union);
  const { error } = await db.from('tenant_profiles')
    .update({ seed_vocabulary: sv, last_updated: new Date().toISOString() })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`setTenantMenuMeta: ${error.message}`);
}

export async function getTenantMenuTokens(tenantId: string): Promise<string[]> {
  const db = getDb();
  const { data } = await db.from('tenant_profiles').select('seed_vocabulary').eq('tenant_id', tenantId).maybeSingle();
  return (((data as any)?.seed_vocabulary as any)?.menu_tokens as string[]) ?? [];
}

export async function getTenantMenuForms(tenantId: string): Promise<MenuForm[]> {
  const db = getDb();
  const { data } = await db.from('tenant_profiles').select('seed_vocabulary').eq('tenant_id', tenantId).maybeSingle();
  const raw = (((data as any)?.seed_vocabulary as any)?.menu_forms as { n: string; t: string[] }[]) ?? [];
  return raw.map(r => ({ name: r.n, tokens: r.t }));
}

export async function getTenantMenuCount(tenantId: string): Promise<number> {
  const db = getDb();
  const { count, error } = await db
    .from('menu_items')
    .select('item_id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId);
  if (error) throw new Error(`getTenantMenuCount: ${error.message}`);
  return count ?? 0;
}
