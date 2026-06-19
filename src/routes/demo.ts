import path from 'path';
import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getRecentMisses, getRecentSemanticHits } from '../db/queries/demo';

export const demoRouter = Router();

// GET /demo → serve the demo HTML
demoRouter.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'demo', 'index.html'));
});

// POST /demo/claude
// Proxy for Claude API calls — keeps the API key server-side.
// Body: { system_prompt: string, user_message: string }
demoRouter.post('/claude', async (req: Request, res: Response) => {
  const { system_prompt, user_message } = req.body as {
    system_prompt?: string;
    user_message?:  string;
  };

  if (!user_message) {
    res.status(400).json({ error: 'user_message is required' });
    return;
  }

  if (!config.anthropic.apiKey) {
    res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });
    return;
  }

  try {
    const client = new Anthropic({ apiKey: config.anthropic.apiKey });
    const message = await client.messages.create({
      model:      config.anthropic.model,
      max_tokens: 512,
      system:     system_prompt ?? 'You are a helpful restaurant ordering assistant.',
      messages:   [{ role: 'user', content: user_message }],
    });

    const text = message.content[0]?.type === 'text' ? message.content[0].text : '';
    res.json({ response: text });
  } catch (err) {
    console.error('POST /demo/claude error:', (err as Error).message);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /demo/phrases → serve the phrases browser HTML
demoRouter.get('/phrases', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'demo', 'phrases.html'));
});

// GET /demo/phrases-data?lang= → live corpus from term_variants, grouped by language
demoRouter.get('/phrases-data', async (req: Request, res: Response) => {
  const { getDb } = await import('../db/client');
  const db = getDb();

  const langFilter = req.query['lang'] as string | undefined;

  // Fetch terms first (with optional language filter)
  let termQuery = db
    .from('lexos_terms')
    .select('term_id, language_code, intent_id')
    .eq('active', true);
  if (langFilter) termQuery = termQuery.eq('language_code', langFilter);
  const { data: terms, error: termErr } = await termQuery.limit(2000);
  if (termErr) { res.status(500).json({ error: termErr.message }); return; }
  if (!terms || terms.length === 0) { res.json({}); return; }

  type TermRow = { term_id: string; language_code: string; intent_id: string };
  const termRows = terms as TermRow[];
  const termIds  = termRows.map(t => t.term_id);
  const termMap  = new Map(termRows.map(t => [t.term_id, t]));

  // Fetch all intents for lookup
  const { data: intents, error: intentErr } = await db
    .from('lexos_intents')
    .select('intent_id, intent_name');
  if (intentErr) { res.status(500).json({ error: intentErr.message }); return; }
  const intentMap = new Map(((intents ?? []) as { intent_id: string; intent_name: string }[]).map(i => [i.intent_id, i.intent_name]));

  // Fetch variants in chunks (avoid URL length limit)
  const CHUNK = 100;
  type VarRow = { term_id: string; value: string; variant_type: string; confidence: number | null };
  const allVariants: VarRow[] = [];
  for (let i = 0; i < termIds.length; i += CHUNK) {
    const chunk = termIds.slice(i, i + CHUNK);
    const { data: vars, error: varErr } = await db
      .from('term_variants')
      .select('term_id, value, variant_type, confidence')
      .in('term_id', chunk)
      .order('variant_type');
    if (varErr) { res.status(500).json({ error: varErr.message }); return; }
    allVariants.push(...((vars ?? []) as VarRow[]));
  }

  // Group by language
  const grouped: Record<string, { value: string; variant_type: string; confidence: number | null; intent_name: string }[]> = {};
  for (const v of allVariants) {
    const term = termMap.get(v.term_id);
    if (!term) continue;
    const lang = term.language_code;
    const intentName = intentMap.get(term.intent_id) ?? '';
    if (!grouped[lang]) grouped[lang] = [];
    grouped[lang].push({ value: v.value, variant_type: v.variant_type, confidence: v.confidence, intent_name: intentName });
  }

  res.json(grouped);
});

// GET /demo/recent-misses?lang=&workflow=&limit=
demoRouter.get('/recent-misses', async (req: Request, res: Response) => {
  try {
    const misses = await getRecentMisses({
      lang:     req.query['lang']     as string | undefined,
      workflow: req.query['workflow'] as string | undefined,
      limit:    req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 20,
    });
    res.json({ misses });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /demo/recent-semantic-hits?lang=&workflow=&limit=
demoRouter.get('/recent-semantic-hits', async (req: Request, res: Response) => {
  try {
    const hits = await getRecentSemanticHits({
      lang:     req.query['lang']     as string | undefined,
      workflow: req.query['workflow'] as string | undefined,
      limit:    req.query['limit'] ? parseInt(req.query['limit'] as string, 10) : 20,
    });
    res.json({ hits });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
