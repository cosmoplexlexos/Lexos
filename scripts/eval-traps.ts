/**
 * eval-traps.ts
 * Head-to-head on held-out adversarial phrases (shared function words, different
 * intents). For each phrase: embed once, then compare the OLD decision rule
 * (NN-to-centroid via semanticMatch) against the NEW classifier head.
 *
 * Usage: npx ts-node scripts/eval-traps.ts
 */
import * as dotenv from 'dotenv'; dotenv.config({ override: true });
import * as fs from 'fs';
import * as path from 'path';
import { generateEmbedding } from '../src/adapters/cloudflare-ai';
import { semanticMatch } from '../src/db/queries/semantic';
import { classifyIntent } from '../src/classifier/intent-classifier';

const short = (s: string | null) => (s ? s.replace('LEXOS_', '') : 'MISS');

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'trap-eval.json'), 'utf-8'));
  const cases = data.cases as { lang: string; phrase: string; expected: string }[];
  const ood = (data.ood ?? []) as { lang: string; phrase: string }[];
  let nnOk = 0, clsOk = 0;
  const rows: string[] = [];

  for (const c of cases) {
    const emb = await generateEmbedding(c.phrase);
    const nn  = await semanticMatch(emb, c.lang, 'restaurant', undefined);      // legacy NN (default threshold)
    const sim = await semanticMatch(emb, c.lang, 'restaurant', undefined, 0);   // true nearest centroid sim
    const cls = classifyIntent(emb, c.lang);

    const nnHit  = (nn?.intent ?? null) === c.expected;
    const clsHit = (cls?.intent ?? null) === c.expected;
    if (nnHit) nnOk++;
    if (clsHit) clsOk++;

    rows.push(
      `  [${c.lang}] ${('"' + c.phrase + '"').padEnd(34)} exp ${short(c.expected).padEnd(20)} ` +
      `NN ${(nnHit ? '✓' : '✗')}  CLS ${clsHit ? '✓' : '✗'} ${short(cls?.intent ?? null).padEnd(20)} ` +
      `p=${cls ? (cls.prob * 100).toFixed(0).padStart(3) : ' --'}%  nearSim=${(sim?.confidence ?? 0).toFixed(2)}`
    );
  }

  console.log('\n══ HELD-OUT TRAP EVAL — NN vs Classifier ══\n');
  console.log(rows.join('\n'));
  console.log(`\n══ SCORE ══`);
  console.log(`  NN (old):         ${nnOk}/${cases.length}`);
  console.log(`  Classifier (new): ${clsOk}/${cases.length}`);

  if (ood.length) {
    console.log(`\n══ OOD PROBES (should be rejected → miss) ══\n`);
    for (const o of ood) {
      const emb = await generateEmbedding(o.phrase);
      const sim = await semanticMatch(emb, o.lang, 'restaurant', undefined, 0);
      const cls = classifyIntent(emb, o.lang);
      console.log(`  [${o.lang}] ${('"' + o.phrase + '"').padEnd(34)} CLS ${short(cls?.intent ?? null).padEnd(20)} p=${cls ? (cls.prob * 100).toFixed(0).padStart(3) : ' --'}%  nearSim=${(sim?.confidence ?? 0).toFixed(2)}`);
    }
  }
  console.log();
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
