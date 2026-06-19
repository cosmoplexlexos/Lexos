import { Router, Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { config } from '../config';
import {
  upsertTenantProfile, getTenantProfile, listTenantProfiles,
} from '../db/queries/tenants';
import { createApiKey, listApiKeys, revokeApiKey } from '../db/queries/apiKeys';
import { replaceTenantMenu, getTenantMenuCount, setTenantMenuMeta } from '../db/queries/menu';
import { expandMenuItems } from '../menu/expand';
import { invalidateMenuCache } from '../menu/menu-matcher';
import { generateEmbeddingsBatch, EMBED_MODEL_NAME } from '../adapters/cloudflare-ai';
import { normalizeRoman } from '../classifier/normalize';
import { tokenize } from '../classifier/text-tokens';
import { startRetrain, getRetrainStatus } from '../admin/retrain-job';
import { adminAuth } from '../middleware/auth';

export const adminRouter = Router();

// HTML shell — public (login screen handles auth client-side)
adminRouter.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), 'demo', 'admin.html'));
});

// All API routes below require the admin key
adminRouter.use((_req: Request, res: Response, next: NextFunction) => adminAuth(_req, res, next));

// ── Tenants ────────────────────────────────────────────────
adminRouter.post('/tenants', async (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  const tenant_id = (b.tenant_id as string | undefined)?.trim();
  if (!tenant_id) { res.status(400).json({ error: 'tenant_id is required' }); return; }
  if (b.register_preference && !['formal', 'colloquial', 'mixed'].includes(b.register_preference as string)) {
    res.status(400).json({ error: 'register_preference must be formal | colloquial | mixed' }); return;
  }
  try {
    const profile = await upsertTenantProfile({
      tenant_id,
      display_name:        b.display_name as string | undefined,
      tenant_type:         'business',
      primary_language:    b.primary_language as string | undefined,
      geographic_region:   b.geographic_region as string | undefined,
      register_preference: b.register_preference as 'formal' | 'colloquial' | 'mixed' | undefined,
      customer_demographic: b.languages ? { languages: b.languages } : undefined,
    });
    res.status(200).json({ tenant: profile });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

adminRouter.get('/tenants', async (_req: Request, res: Response) => {
  try {
    const tenants = await listTenantProfiles();
    const withCounts = await Promise.all(tenants.map(async t => ({
      ...t, menu_count: await getTenantMenuCount(t.tenant_id).catch(() => 0),
    })));
    res.json({ tenants: withCounts });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

adminRouter.get('/tenants/:id', async (req: Request, res: Response) => {
  try {
    const profile = await getTenantProfile(req.params.id);
    if (!profile) { res.status(404).json({ error: 'tenant not found' }); return; }
    const [menu_count, keys] = await Promise.all([
      getTenantMenuCount(req.params.id),
      listApiKeys(req.params.id),
    ]);
    res.json({ tenant: profile, menu_count, api_keys: keys });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Menu upload (embed + store) ────────────────────────────
adminRouter.post('/tenants/:id/menu', async (req: Request, res: Response) => {
  const tenant_id = req.params.id;
  const items = (req.body as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array of { name, category?, price? }' }); return;
  }
  const raw = items.map((it: any) => (typeof it === 'string' ? { name: it } : it));
  // Expand each item into its surface forms (English + languages + aliases).
  const forms = expandMenuItems(raw);
  if (forms.length === 0) { res.status(400).json({ error: 'no valid item names' }); return; }

  try {
    const vecs = await generateEmbeddingsBatch(forms.map(f => normalizeRoman(f.text)), 50);
    const rows = forms.map((f, i) => ({ name: f.name, category: f.category, price: f.price, embedding: vecs[i] }));
    const count = await replaceTenantMenu(tenant_id, rows, EMBED_MODEL_NAME);
    const meta = forms.map(f => ({ name: f.name, tokens: tokenize(normalizeRoman(f.text)) }));
    await setTenantMenuMeta(tenant_id, meta);
    invalidateMenuCache(tenant_id);
    const distinctItems = new Set(forms.map(f => f.name)).size;
    res.json({ tenant_id, items: distinctItems, surface_forms_ingested: count });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── API keys ───────────────────────────────────────────────
adminRouter.post('/tenants/:id/api-keys', async (req: Request, res: Response) => {
  try {
    const profile = await getTenantProfile(req.params.id);
    if (!profile) { res.status(404).json({ error: 'tenant not found' }); return; }
    const { label, product_id } = req.body as { label?: string; product_id?: string };
    const created = await createApiKey(req.params.id, { label, product_id });
    res.json({
      tenant_id: req.params.id,
      key: created.key,            // shown ONCE — store it now
      key_prefix: created.key_prefix,
      note: 'Store this key now — it is not retrievable later.',
    });
  } catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

adminRouter.get('/tenants/:id/api-keys', async (req: Request, res: Response) => {
  try { res.json({ api_keys: await listApiKeys(req.params.id) }); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

adminRouter.post('/api-keys/:key_id/revoke', async (req: Request, res: Response) => {
  try { await revokeApiKey(req.params.key_id); res.json({ revoked: req.params.key_id }); }
  catch (err) { res.status(500).json({ error: (err as Error).message }); }
});

// ── Training ───────────────────────────────────────────────
adminRouter.post('/retrain', (_req: Request, res: Response) => {
  res.json({ job: startRetrain() });
});
adminRouter.get('/retrain/status', (_req: Request, res: Response) => {
  res.json({ job: getRetrainStatus() });
});

// ── Vocabulary generation (future — gated) ─────────────────
adminRouter.post('/tenants/:id/generate-vocab', (_req: Request, res: Response) => {
  if (!config.generationEnabled) {
    res.status(503).json({
      error: 'vocabulary generation is disabled',
      hint: 'set GENERATION_ENABLED=true and ANTHROPIC_API_KEY to enable Claude-driven generation',
    });
    return;
  }
  // Plumbing ready; wired to the generation pipeline when enabled.
  res.status(501).json({ error: 'generation enabled but pipeline not yet wired' });
});
