import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { validateApiKey } from '../db/queries/apiKeys';

// ──────────────────────────────────────────────────────────
// API key middleware for external-facing routes (/enrich, /retrieve).
//
// Accepts either:
//   - the master LEXOS_API_KEY (if set), or
//   - any active per-tenant key (api_keys table) — the calling tenant is then
//     resolved from the key and injected as X-Tenant-ID (unless the caller
//     already sent one).
//
// If no master key is configured AND no key header is sent, the request is
// allowed (local dev). In production, set LEXOS_API_KEY and/or issue tenant keys.
//
// Clients pass the key as: X-API-Key: <secret>
// ──────────────────────────────────────────────────────────
export async function apiKeyAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['x-api-key'] as string | undefined;

  if (!key) {
    if (!config.apiKey) { next(); return; }              // dev mode, no key required
    res.status(401).json({ error: 'Unauthorized — valid X-API-Key header required' });
    return;
  }

  if (config.apiKey && key === config.apiKey) { next(); return; } // master key

  try {
    const resolved = await validateApiKey(key);
    if (resolved) {
      // Per-tenant key → bind the tenant unless the caller specified one.
      if (!req.headers['x-tenant-id']) req.headers['x-tenant-id'] = resolved.tenant_id;
      if (resolved.product_id && !req.headers['x-product-id']) req.headers['x-product-id'] = resolved.product_id;
      next();
      return;
    }
  } catch (err) {
    console.error('apiKeyAuth lookup failed:', (err as Error).message);
  }
  res.status(401).json({ error: 'Unauthorized — invalid X-API-Key' });
}

/**
 * Admin dashboard auth. Protects all /admin routes via X-Admin-Key.
 * If LEXOS_ADMIN_KEY is unset, admin routes are open (local dev only).
 */
export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.adminKey) { next(); return; } // dev mode
  const key = (req.headers['x-admin-key'] as string | undefined) ?? '';
  if (key !== config.adminKey) {
    res.status(401).json({ error: 'Unauthorized — valid X-Admin-Key header required' });
    return;
  }
  next();
}
