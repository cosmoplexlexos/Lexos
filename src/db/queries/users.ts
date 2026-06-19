import { getDb } from '../client';

// ──────────────────────────────────────────────────────────
// user_profiles queries
// ──────────────────────────────────────────────────────────

export interface UserProfile {
  user_id:              string;
  native_language:      string | null;
  geographic_region:    string | null;
  explicit_preferences: Record<string, unknown> | null;
  learned_patterns:     Record<string, unknown> | null;
  interaction_count:    number;
  last_updated:         string;
}

export interface UpdateUserPreferencesInput {
  native_language?:     string;
  geographic_region?:   string;
  explicit_preferences?: Record<string, unknown>;
}

/** Returns a user profile or null if not found. */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const db = getDb();
  const { data, error } = await db
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`getUserProfile: ${error.message}`);
  }
  return data as UserProfile;
}

/**
 * Applies explicit user preference overrides.
 * Creates the profile row if it doesn't exist yet.
 */
export async function updateUserPreferences(
  userId: string,
  input:  UpdateUserPreferencesInput,
): Promise<UserProfile> {
  const db = getDb();

  const payload: Record<string, unknown> = {
    user_id:      userId,
    last_updated: new Date().toISOString(),
  };

  if (input.native_language     !== undefined) payload.native_language     = input.native_language;
  if (input.geographic_region   !== undefined) payload.geographic_region   = input.geographic_region;
  if (input.explicit_preferences !== undefined) payload.explicit_preferences = input.explicit_preferences;

  const { data, error } = await db
    .from('user_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) throw new Error(`updateUserPreferences: ${error.message}`);
  return data as UserProfile;
}

/**
 * Records one interaction and optionally updates the inferred native_language.
 * Language inference kicks in after INFER_LANGUAGE_AFTER interactions (default 20).
 * Called fire-and-forget from the enrich path.
 */
export async function recordInteraction(
  userId:   string,
  lang:     string,
): Promise<void> {
  const db = getDb();

  // Fetch current profile (or create baseline)
  const { data: current } = await db
    .from('user_profiles')
    .select('interaction_count, native_language, learned_patterns')
    .eq('user_id', userId)
    .single();

  const prev       = current as { interaction_count: number; native_language: string | null; learned_patterns: Record<string, unknown> | null } | null;
  const count      = (prev?.interaction_count ?? 0) + 1;
  const patterns   = (prev?.learned_patterns ?? {}) as Record<string, number>;

  // Tally language usage
  patterns[lang] = (patterns[lang] ?? 0) + 1;

  // After threshold, infer native language from most-used lang
  const THRESHOLD = parseInt(process.env['INFER_LANGUAGE_AFTER'] ?? '20', 10);
  let inferred = prev?.native_language;
  if (count >= THRESHOLD && !prev?.native_language) {
    // Pick the language with the highest count
    inferred = Object.entries(patterns).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  const { error } = await db
    .from('user_profiles')
    .upsert(
      {
        user_id:           userId,
        interaction_count: count,
        learned_patterns:  patterns,
        native_language:   inferred,
        last_updated:      new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    );

  if (error) throw new Error(`recordInteraction: ${error.message}`);
}
