import { getTenantMenuItems, getTenantMenuTokens, getTenantMenuForms, MenuItemVec } from '../db/queries/menu';
import { tokenize } from '../classifier/text-tokens';
import { normalizeRoman } from '../classifier/normalize';

// ──────────────────────────────────────────────────────────
// Menu matcher — per-tenant item grounding by vector similarity.
//
// Each tenant's menu items (uploaded via the admin dashboard) are embedded with
// bge-m3 and stored in menu_items. At request time we compare the (already
// computed) utterance embedding against this tenant's item vectors. Semantic
// similarity is the right tool HERE (unlike intent): "filter kaapi" ≈ "Filter
// Coffee". A match above the floor means an item is present; null means none —
// the signal the composition step uses to separate item actions (add/remove/
// price-of-item) from order actions (checkout/total) and out-of-domain input.
//
// Items are cached in-process (loaded from DB on first use) with a short TTL,
// and the cache is invalidated when the dashboard re-uploads a menu.
// ──────────────────────────────────────────────────────────

export interface MenuMatch { name: string; sim: number; }

const TTL_MS = 5 * 60 * 1000;
interface CacheEntry { items: MenuItemVec[]; loadedAt: number; }
interface FormEntry { name: string; tokens: Set<string> }
const _cache = new Map<string, CacheEntry>();
const _tokCache = new Map<string, { tokens: Set<string>; loadedAt: number }>();
const _formCache = new Map<string, { forms: FormEntry[]; loadedAt: number }>();

// Date.now is fine in the server runtime (this is not a workflow script).
function now(): number { return Date.now(); }

export function invalidateMenuCache(tenant?: string): void {
  if (tenant) { _cache.delete(tenant); _tokCache.delete(tenant); _formCache.delete(tenant); }
  else { _cache.clear(); _tokCache.clear(); _formCache.clear(); }
}

/** Cached per-surface-form token sets for lexical span matching. */
export async function loadTenantMenuForms(tenant: string): Promise<FormEntry[]> {
  const hit = _formCache.get(tenant);
  if (hit && now() - hit.loadedAt < TTL_MS) return hit.forms;
  let forms: FormEntry[] = [];
  try { forms = (await getTenantMenuForms(tenant)).map(f => ({ name: f.name, tokens: new Set(f.tokens) })); }
  catch { forms = hit?.forms ?? []; }
  _formCache.set(tenant, { forms, loadedAt: now() });
  return forms;
}

/** Cached set of a tenant's menu surface-form tokens (for the unknown-content gate). */
export async function loadTenantMenuTokens(tenant: string): Promise<Set<string>> {
  const hit = _tokCache.get(tenant);
  if (hit && now() - hit.loadedAt < TTL_MS) return hit.tokens;
  let tokens = new Set<string>();
  try { tokens = new Set(await getTenantMenuTokens(tenant)); } catch { tokens = hit?.tokens ?? new Set(); }
  _tokCache.set(tenant, { tokens, loadedAt: now() });
  return tokens;
}

/** Loads (and caches) a tenant's embedded menu items. Empty array if no menu. */
export async function loadTenantMenu(tenant: string): Promise<MenuItemVec[]> {
  const hit = _cache.get(tenant);
  if (hit && now() - hit.loadedAt < TTL_MS) return hit.items;
  let items: MenuItemVec[] = [];
  try { items = await getTenantMenuItems(tenant); } catch { items = hit?.items ?? []; }
  _cache.set(tenant, { items, loadedAt: now() });
  return items;
}

function l2norm(v: number[]): number[] {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}

/** Embedding (cosine) match — fallback for paraphrases not present lexically. */
export function matchInMenu(items: MenuItemVec[], embedding: number[], floor: number): MenuMatch | null {
  if (!items.length) return null;
  const q = l2norm(embedding);
  let best: MenuMatch | null = null;
  for (const it of items) {
    let dot = 0;
    const e = it.embedding;
    for (let i = 0; i < q.length; i++) dot += q[i] * e[i];
    if (!best || dot > best.sim) best = { name: it.name, sim: dot };
  }
  return best && best.sim >= floor ? best : null;
}

/** Lexical span match: the menu form whose tokens are all PRESENT in the
 *  utterance, preferring the most specific (most tokens). Fixes variant
 *  precision — "masala dosa" → Masala Dosa, not "Open Masala Dosa". */
function lexicalMatch(forms: FormEntry[], utterance: Set<string>): MenuMatch | null {
  let best: MenuMatch | null = null;
  for (const f of forms) {
    if (f.tokens.size === 0) continue;
    let all = true;
    for (const t of f.tokens) if (!utterance.has(t)) { all = false; break; }
    if (all && (!best || f.tokens.size > best.sim)) best = { name: f.name, sim: f.tokens.size };
  }
  return best; // sim here is the token count, not a similarity
}

export async function tenantHasMenu(tenant: string): Promise<boolean> {
  return (await loadTenantMenuForms(tenant)).length > 0;
}

/** Lexical-only item resolve (no embedding) — used on the exact-match path to
 *  fill the item slot for a phrase that already matched a corpus entry. */
export async function matchMenuItemLexical(tenant: string, phrase: string): Promise<MenuMatch | null> {
  const forms = await loadTenantMenuForms(tenant);
  return lexicalMatch(forms, new Set(tokenize(normalizeRoman(phrase))));
}

/**
 * Resolve the menu item named in an utterance: lexical span match first
 * (precise variant), embedding similarity as fallback (paraphrase/synonymy).
 */
export async function matchMenuItem(
  tenant: string, phrase: string, embedding: number[], floor: number,
): Promise<MenuMatch | null> {
  const forms = await loadTenantMenuForms(tenant);
  const lex = lexicalMatch(forms, new Set(tokenize(normalizeRoman(phrase))));
  if (lex) return lex;
  const items = await loadTenantMenu(tenant);
  return matchInMenu(items, embedding, floor);
}
