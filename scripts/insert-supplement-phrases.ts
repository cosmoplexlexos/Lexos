/**
 * insert-supplement-phrases.ts
 *
 * Inserts additional phrases from supplement-phrases.json into the corpus,
 * then regenerates embeddings for each updated term from its full COLLOQUIAL
 * variant set.
 *
 * Usage: npx ts-node scripts/insert-supplement-phrases.ts
 *        npx ts-node scripts/insert-supplement-phrases.ts --dry-run
 */

import * as dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');

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

async function processIntentLang(
  intentName: string,
  langCode: string,
  newVariants: Record<string, string[]>
) {
  // 1. Find intent UUID
  const { data: intentRow } = await supabase
    .from('lexos_intents')
    .select('intent_id')
    .eq('intent_name', intentName)
    .single();
  if (!intentRow) { console.warn(`  ⚠  Intent not found: ${intentName}`); return; }

  // 2. Find term_id
  const { data: terms } = await supabase
    .from('lexos_terms')
    .select('term_id')
    .eq('intent_id', intentRow.intent_id)
    .eq('language_code', langCode)
    .limit(1);
  if (!terms?.length) { console.warn(`  ⚠  No term for ${intentName}/${langCode}`); return; }
  const termId = terms[0].term_id;

  // 3. Get existing variant values to skip duplicates
  const { data: existing } = await supabase
    .from('term_variants')
    .select('value')
    .eq('term_id', termId);
  const existingSet = new Set((existing ?? []).map((r: any) => r.value.trim().toLowerCase()));

  // 4. Build rows to insert (skip duplicates)
  const rows: any[] = [];
  for (const [variantType, phrases] of Object.entries(newVariants)) {
    for (const phrase of phrases) {
      if (existingSet.has(phrase.trim().toLowerCase())) continue;
      rows.push({ term_id: termId, variant_type: variantType, value: phrase.trim(), confidence: 0.92 });
    }
  }

  if (rows.length === 0) {
    console.log(`  ↷  ${intentName}/${langCode} — all phrases already exist, skipped`);
    return;
  }

  if (DRY_RUN) {
    console.log(`  [dry] ${intentName}/${langCode} — would insert ${rows.length} variants`);
    return;
  }

  // 5. Insert new variants
  const { error: varErr } = await supabase.from('term_variants').insert(rows);
  if (varErr) { console.error(`  ✗  Insert failed ${intentName}/${langCode}: ${varErr.message}`); return; }

  // 6. Regenerate embedding from ALL COLLOQUIAL variants (post-insert)
  const { data: allColl } = await supabase
    .from('term_variants')
    .select('value')
    .eq('term_id', termId)
    .eq('variant_type', 'COLLOQUIAL');

  const embText = (allColl ?? []).map((r: any) => r.value).join(' ') || 'menu-item';

  try {
    const embedding = await generateEmbedding(embText);
    const embeddingStr = `[${embedding.join(',')}]`;
    await supabase.from('vector_embeddings').delete().eq('term_id', termId);
    const { error: embErr } = await supabase.from('vector_embeddings').insert({
      term_id: termId, embedding: embeddingStr, model_version: '1', model_name: '@cf/baai/bge-m3',
    });
    if (embErr) console.error(`  ✗  Embedding ${intentName}/${langCode}: ${embErr.message}`);
    else console.log(`  ✓  ${intentName}/${langCode} — +${rows.length} variants, embedding updated`);
  } catch (err) {
    console.error(`  ✗  Embedding gen ${intentName}/${langCode}: ${(err as Error).message}`);
  }

  await new Promise(r => setTimeout(r, 250));
}

async function main() {
  console.log(`\nLexos — supplement phrase insertion${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const fileArg = process.argv.slice(2).find(a => a.endsWith('.json'));
  const dataPath = fileArg
    ? (path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg))
    : path.join(__dirname, 'data', 'supplement-phrases.json');
  console.log(`Source: ${dataPath}`);
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));

  let total = 0;
  for (const [intentName, langMap] of Object.entries(data) as any[]) {
    console.log(`\n${intentName}`);
    for (const [langCode, variants] of Object.entries(langMap) as any[]) {
      await processIntentLang(intentName, langCode, variants);
      total++;
    }
  }

  console.log(`\nDone. Processed ${total} intent/language combinations.`);
}

main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
