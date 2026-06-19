/**
 * ingest-menu.ts
 *
 * Ingest a tenant's structured menu into the DB: upsert the tenant, expand each
 * item into its surface forms (English + each language + aliases), embed every
 * form with Cloudflare bge-m3, and store in menu_items (one row per form, all
 * sharing the canonical name). Offline; Cloudflare only.
 *
 * Menu JSON: { tenant_id, display_name?, items: [{ name, category?, price?, names?, aliases? }] }
 *
 * Usage: npx ts-node scripts/ingest-menu.ts scripts/data/<menu>.json
 */
import * as dotenv from 'dotenv'; dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { generateEmbeddingsBatch, EMBED_MODEL_NAME } from '../src/adapters/cloudflare-ai';
import { normalizeRoman } from '../src/classifier/normalize';
import { tokenize } from '../src/classifier/text-tokens';
import { expandMenuItems } from '../src/menu/expand';
import { replaceTenantMenu, setTenantMenuMeta } from '../src/db/queries/menu';
import { upsertTenantProfile } from '../src/db/queries/tenants';

async function main() {
  const fileArg = process.argv.slice(2).find(a => a.endsWith('.json'));
  if (!fileArg) { console.error('Usage: ingest-menu.ts <menu.json>'); process.exit(1); }
  const src = JSON.parse(fs.readFileSync(path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg), 'utf-8'));
  const tenant: string = src.tenant_id;
  if (!tenant) throw new Error('menu JSON must include tenant_id');

  await upsertTenantProfile({ tenant_id: tenant, display_name: src.display_name, tenant_type: 'business' });

  const forms = expandMenuItems(src.items ?? []);
  const distinctItems = new Set(forms.map(f => f.name)).size;
  console.log(`\nTenant "${tenant}": ${distinctItems} items → ${forms.length} surface forms. Embedding…`);

  const vecs = await generateEmbeddingsBatch(forms.map(f => normalizeRoman(f.text)), 50);
  const rows = forms.map((f, i) => ({ name: f.name, category: f.category, price: f.price, embedding: vecs[i] }));

  const count = await replaceTenantMenu(tenant, rows, EMBED_MODEL_NAME);

  // Store per-form tokens (lexical matching) + their union (unknown-content gate).
  const meta = forms.map(f => ({ name: f.name, tokens: tokenize(normalizeRoman(f.text)) }));
  await setTenantMenuMeta(tenant, meta);

  console.log(`Stored ${count} menu rows + ${meta.length} surface-form token sets for "${tenant}".`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
