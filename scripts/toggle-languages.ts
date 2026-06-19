/**
 * toggle-languages.ts
 *
 * Enable or disable whole languages so they are COMPLETELY out of processing
 * when off — including the vector index.
 *
 *   off:  active=false  +  DELETE their embeddings from vector_embeddings
 *         (removes the vectors from the HNSW index entirely, so they are never
 *          traversed during semantic search — not merely post-filtered out).
 *   on:   active=true   +  regenerate one embedding per term from its
 *         COLLOQUIAL variants (Cloudflare bge-m3).
 *
 * Terms + variants are preserved either way, so a disabled language is fully
 * restorable without re-authoring vocabulary.
 *
 * Usage:
 *   npx ts-node scripts/toggle-languages.ts off bn-IN gu-IN es-ES ar-AE
 *   npx ts-node scripts/toggle-languages.ts on  bn-IN gu-IN es-ES ar-AE
 */

import * as dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function generateEmbedding(text: string): Promise<number[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`CF embedding failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  return json.result.data[0];
}

async function disable(lang: string) {
  const { data: terms, error: tErr } = await supabase
    .from('lexos_terms')
    .update({ active: false })
    .eq('language_code', lang)
    .select('term_id');
  if (tErr) { console.error(`  ✗  ${lang} active flag: ${tErr.message}`); return; }

  const termIds = (terms ?? []).map((t: any) => t.term_id);
  let purged = 0;
  if (termIds.length) {
    const { data: del, error: eErr } = await supabase
      .from('vector_embeddings')
      .delete()
      .in('term_id', termIds)
      .select('embedding_id');
    if (eErr) { console.error(`  ✗  ${lang} embedding purge: ${eErr.message}`); return; }
    purged = del?.length ?? 0;
  }
  console.log(`  ✓  ${lang} — ${termIds.length} terms active=false, ${purged} embeddings removed from index`);
}

async function enable(lang: string) {
  const { data: terms, error: tErr } = await supabase
    .from('lexos_terms')
    .update({ active: true })
    .eq('language_code', lang)
    .select('term_id');
  if (tErr) { console.error(`  ✗  ${lang} active flag: ${tErr.message}`); return; }

  const termIds = (terms ?? []).map((t: any) => t.term_id);
  let rebuilt = 0;
  for (const termId of termIds) {
    const { data: colloquial } = await supabase
      .from('term_variants')
      .select('value')
      .eq('term_id', termId)
      .eq('variant_type', 'COLLOQUIAL');
    const embText = (colloquial ?? []).map((r: any) => r.value).join(' ') || 'menu-item';
    try {
      const embedding = await generateEmbedding(embText);
      await supabase.from('vector_embeddings').delete().eq('term_id', termId);
      const { error: insErr } = await supabase.from('vector_embeddings').insert({
        term_id: termId, embedding: `[${embedding.join(',')}]`,
        model_version: '1', model_name: '@cf/baai/bge-m3',
      });
      if (insErr) { console.error(`  ✗  ${lang} ${termId} embed insert: ${insErr.message}`); continue; }
      rebuilt++;
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      console.error(`  ✗  ${lang} ${termId} embed gen: ${(err as Error).message}`);
    }
  }
  console.log(`  ✓  ${lang} — ${termIds.length} terms active=true, ${rebuilt} embeddings regenerated`);
}

async function main() {
  const [mode, ...langs] = process.argv.slice(2);
  if ((mode !== 'on' && mode !== 'off') || langs.length === 0) {
    console.error('Usage: toggle-languages.ts <on|off> <lang-code> [lang-code ...]');
    process.exit(1);
  }

  console.log(`\nToggling ${mode.toUpperCase()} for: ${langs.join(', ')}\n`);
  for (const lang of langs) {
    if (mode === 'off') await disable(lang);
    else                await enable(lang);
  }
  console.log('\nDone.');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
