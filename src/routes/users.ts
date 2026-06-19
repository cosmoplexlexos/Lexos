import { Router, Request, Response } from 'express';
import { updateUserPreferences } from '../db/queries/users';

export const usersRouter = Router();

// PATCH /users/:user_id/preferences
//
// Applies explicit user preference overrides.
// Creates profile row if it doesn't exist.
// Body: { native_language?, geographic_region?, explicit_preferences? }
usersRouter.patch('/:user_id/preferences', async (req: Request, res: Response) => {
  const { user_id } = req.params;
  const {
    native_language,
    geographic_region,
    explicit_preferences,
  } = req.body as Record<string, unknown>;

  if (!user_id) {
    res.status(400).json({ error: 'user_id is required' });
    return;
  }

  if (
    native_language === undefined &&
    geographic_region === undefined &&
    explicit_preferences === undefined
  ) {
    res.status(400).json({ error: 'at least one preference field is required' });
    return;
  }

  try {
    const profile = await updateUserPreferences(user_id, {
      native_language:      native_language as string | undefined,
      geographic_region:    geographic_region as string | undefined,
      explicit_preferences: explicit_preferences as Record<string, unknown> | undefined,
    });

    res.status(200).json({ user_id, profile });
  } catch (err) {
    console.error('PATCH /users/:id/preferences error:', (err as Error).message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
