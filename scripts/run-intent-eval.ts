/**
 * run-intent-eval.ts
 * Runs scripts/data/intent-eval.json through POST /enrich (lang passed
 * explicitly, the WiseOrder flow) and reports PASS / MISCLASSIFIED / MISS
 * per intent and language, with a summary and a failures list.
 *
 * Usage: npx ts-node scripts/run-intent-eval.ts
 */
import * as fs from "fs";
import * as path from "path";

const BASE = process.env.LEXOS_BASE ?? "http://localhost:3000";

interface Result { intent: string; lang: string; phrase: string; expected: string; actual: string | null; match: string; status: "PASS" | "WRONG" | "MISS"; }

async function enrich(phrase: string, lang: string): Promise<{ intent: string | null; match_type: string }> {
  const res = await fetch(`${BASE}/enrich`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phrase, lang, domain: "restaurant" }),
  });
  if (!res.ok) throw new Error(`enrich ${res.status}`);
  const j = await res.json() as any;
  return { intent: j.intent ?? null, match_type: j.match_type };
}

async function main() {
  const fileArg = process.argv.slice(2).find(a => a.endsWith(".json"));
  const dataPath = fileArg
    ? (path.isAbsolute(fileArg) ? fileArg : path.join(process.cwd(), fileArg))
    : path.join(__dirname, "data", "intent-eval.json");
  console.log(`Eval set: ${dataPath}`);
  const data = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
  const results: Result[] = [];

  for (const [intent, langMap] of Object.entries(data) as [string, Record<string, string[]>][]) {
    for (const [lang, phrases] of Object.entries(langMap)) {
      for (const phrase of phrases) {
        try {
          const { intent: actual, match_type } = await enrich(phrase, lang);
          const status = actual === intent ? "PASS" : actual === null ? "MISS" : "WRONG";
          results.push({ intent, lang, phrase, expected: intent, actual, match: match_type, status });
        } catch (e) {
          results.push({ intent, lang, phrase, expected: intent, actual: null, match: "ERR", status: "MISS" });
        }
      }
    }
  }

  const pass = results.filter(r => r.status === "PASS").length;
  const wrong = results.filter(r => r.status === "WRONG");
  const miss = results.filter(r => r.status === "MISS");

  console.log(`\n══ FAILURES ══\n`);
  for (const r of [...wrong, ...miss]) {
    const got = r.status === "MISS" ? "MISS" : `${r.actual} [${r.match}]`;
    console.log(`  ${r.status.padEnd(5)} [${r.lang}] ${r.expected.replace("LEXOS_", "").padEnd(26)} "${r.phrase}"  →  ${got}`);
  }

  // Per-intent breakdown
  console.log(`\n══ PER-INTENT ══\n`);
  const byIntent: Record<string, { pass: number; total: number }> = {};
  for (const r of results) {
    byIntent[r.intent] ??= { pass: 0, total: 0 };
    byIntent[r.intent].total++;
    if (r.status === "PASS") byIntent[r.intent].pass++;
  }
  for (const [intent, s] of Object.entries(byIntent)) {
    const flag = s.pass === s.total ? "✓" : "✗";
    console.log(`  ${flag} ${intent.replace("LEXOS_", "").padEnd(28)} ${s.pass}/${s.total}`);
  }

  console.log(`\n══ SUMMARY ══`);
  console.log(`  PASS: ${pass}/${results.length}  |  WRONG: ${wrong.length}  |  MISS: ${miss.length}\n`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
