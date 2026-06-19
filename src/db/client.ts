import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

// ──────────────────────────────────────────────────────────
// Supabase client — singleton, service-role key.
// All DB access goes through /src/db/ — never import this
// directly in route handlers.
// ──────────────────────────────────────────────────────────

let _client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      config.supabase.url,
      config.supabase.serviceRoleKey,
      {
        auth: {
          autoRefreshToken: false,
          persistSession:   false,
        },
      }
    );
  }
  return _client;
}
