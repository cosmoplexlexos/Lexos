import { Router, Request, Response } from 'express';
import { upsertTenantProfile, mergeTenantVocabulary, getTenantProfile } from '../db/queries/tenants';

export const tenantsRouter = Router();

// POST /tenants/:tenant_id/configure
//
// Creates or updates a tenant profile.
// All fields optional except tenant_id (from path param).
tenantsRouter.post('/:tenant_id/configure', async (req: Request, res: Response) => {
  const { tenant_id } = req.params;
  const {
    tenant_type,
    primary_language,
    geographic_region,
    register_preference,
    customer_demographic,
    seed_vocabulary,
  } = req.body as Record<string, unknown>;

  if (!tenant_id) {
    res.status(400).json({ error: 'tenant_id is required' });
    return;
  }

  // Validate register_preference if provided
  if (register_preference !== undefined &&
      !['formal', 'colloquial', 'mixed'].includes(register_preference as string)) {
    res.status(400).json({ error: 'register_preference must be formal | colloquial | mixed' });
    return;
  }

  // Validate tenant_type if provided
  if (tenant_type !== undefined && !['business', 'user'].includes(tenant_type as string)) {
    res.status(400).json({ error: 'tenant_type must be business | user' });
    return;
  }

  try {
    const profile = await upsertTenantProfile({
      tenant_id,
      tenant_type:          tenant_type as 'business' | 'user' | undefined,
      primary_language:     primary_language as string | undefined,
      geographic_region:    geographic_region as string | undefined,
      register_preference:  register_preference as 'formal' | 'colloquial' | 'mixed' | undefined,
      customer_demographic: customer_demographic as Record<string, unknown> | undefined,
      seed_vocabulary:      seed_vocabulary as Record<string, unknown> | undefined,
    });

    res.status(200).json({ tenant_id, profile });
  } catch (err) {
    console.error('POST /tenants/:id/configure error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /tenants/:tenant_id/vocabulary
//
// Appends items to a tenant's seed_vocabulary.
// Body: { items: string[] }
tenantsRouter.post('/:tenant_id/vocabulary', async (req: Request, res: Response) => {
  const { tenant_id } = req.params;
  const { items } = req.body as { items?: unknown };

  if (!tenant_id) {
    res.status(400).json({ error: 'tenant_id is required' });
    return;
  }

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'items must be a non-empty array of strings' });
    return;
  }

  const stringItems = items.filter((i): i is string => typeof i === 'string');
  if (stringItems.length === 0) {
    res.status(400).json({ error: 'items must contain at least one string' });
    return;
  }

  try {
    await mergeTenantVocabulary(tenant_id, stringItems);
    const profile = await getTenantProfile(tenant_id);

    res.status(200).json({
      tenant_id,
      added:           stringItems.length,
      total_vocabulary: (profile?.seed_vocabulary?.items as string[] | undefined)?.length ?? 0,
    });
  } catch (err) {
    console.error('POST /tenants/:id/vocabulary error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
