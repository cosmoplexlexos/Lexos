/**
 * User profile inference and preferences tests
 *
 * Tests:
 *   PATCH /users/:id/preferences
 *     1. Applies explicit preference overrides
 *     2. Rejects empty body (no fields provided)
 *     3. 500 on DB error
 *
 *   recordInteraction / language inference
 *     4. Interaction count increments with each call
 *     5. native_language inferred after 20 interactions
 *     6. Already-set native_language not overwritten by inference
 *     7. Language with highest frequency wins inference
 */

import request from 'supertest';
import app from '../../src/app';
import { recordInteraction } from '../../src/db/queries/users';

// ── Mock DB ──────────────────────────────────────────────────

const mockUpdateUserPreferences = jest.fn();
const mockGetDb                 = jest.fn();

jest.mock('../../src/db/queries/users', () => {
  const actual = jest.requireActual('../../src/db/queries/users');
  return {
    ...actual,
    updateUserPreferences: (...a: unknown[]) => mockUpdateUserPreferences(...a),
  };
});

jest.mock('../../src/db/client', () => ({
  getDb: (...a: unknown[]) => mockGetDb(...a),
}));

// ── Setup ─────────────────────────────────────────────────────

const mockDbSingle  = jest.fn();
const mockDbUpsert  = jest.fn();
const mockDbSelect  = jest.fn();
const mockDbEq      = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockUpdateUserPreferences.mockResolvedValue({
    user_id:              'user-001',
    native_language:      'hi-IN',
    geographic_region:    null,
    explicit_preferences: null,
    learned_patterns:     null,
    interaction_count:    0,
    last_updated:         '2026-06-12T00:00:00Z',
  });
});

// ── PATCH /users/:id/preferences ─────────────────────────────

describe('PATCH /users/:id/preferences', () => {
  test('applies explicit preference overrides', async () => {
    const res = await request(app)
      .patch('/users/user-001/preferences')
      .send({ native_language: 'hi-IN' });

    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe('user-001');
    expect(res.body.profile).toBeDefined();
  });

  test('calls updateUserPreferences with correct fields', async () => {
    await request(app)
      .patch('/users/user-001/preferences')
      .send({
        native_language:     'kn-IN',
        geographic_region:   'Bengaluru',
        explicit_preferences: { preferred_register: 'colloquial' },
      });

    expect(mockUpdateUserPreferences).toHaveBeenCalledWith(
      'user-001',
      expect.objectContaining({
        native_language:      'kn-IN',
        geographic_region:    'Bengaluru',
        explicit_preferences: { preferred_register: 'colloquial' },
      }),
    );
  });

  test('rejects empty body (no preference fields)', async () => {
    const res = await request(app)
      .patch('/users/user-001/preferences')
      .send({});

    expect(res.status).toBe(400);
    expect(mockUpdateUserPreferences).not.toHaveBeenCalled();
  });

  test('returns 500 on DB error', async () => {
    mockUpdateUserPreferences.mockRejectedValue(new Error('DB error'));

    const res = await request(app)
      .patch('/users/user-001/preferences')
      .send({ native_language: 'hi-IN' });

    expect(res.status).toBe(500);
  });
});

// ── recordInteraction — language inference ────────────────────

describe('recordInteraction — language inference', () => {
  function makeDbMock(currentProfile: {
    interaction_count: number;
    native_language: string | null;
    learned_patterns: Record<string, number> | null;
  } | null) {
    const upsertResult = { error: null };
    const singleFn = jest.fn().mockResolvedValue({ data: currentProfile, error: null });
    const eqFn     = jest.fn().mockReturnValue({ single: singleFn });
    const selectFn = jest.fn().mockReturnValue({ eq: eqFn });
    const upsertFn = jest.fn().mockResolvedValue(upsertResult);
    const fromFn   = jest.fn().mockImplementation((table: string) => {
      if (table === 'user_profiles') {
        return { select: selectFn, upsert: upsertFn };
      }
      return {};
    });
    return { fromFn, upsertFn };
  }

  test('language with highest frequency inferred after threshold', async () => {
    // Simulate 19 previous hi-IN interactions, now crossing 20 with the call
    const { fromFn, upsertFn } = makeDbMock({
      interaction_count: 19,
      native_language:   null,
      learned_patterns:  { 'hi-IN': 15, 'en-US': 4 },
    });
    mockGetDb.mockReturnValue({ from: fromFn });

    await recordInteraction('user-001', 'hi-IN');

    // Should call upsert with inferred native_language = 'hi-IN'
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ native_language: 'hi-IN' }),
      expect.anything(),
    );
  });

  test('already-set native_language not overwritten by inference', async () => {
    const { fromFn, upsertFn } = makeDbMock({
      interaction_count: 25,
      native_language:   'kn-IN',  // already set
      learned_patterns:  { 'hi-IN': 20, 'kn-IN': 6 },
    });
    mockGetDb.mockReturnValue({ from: fromFn });

    await recordInteraction('user-001', 'hi-IN');

    // native_language should remain 'kn-IN', not be overwritten by 'hi-IN'
    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ native_language: 'kn-IN' }),
      expect.anything(),
    );
  });

  test('increments interaction_count on every call', async () => {
    const { fromFn, upsertFn } = makeDbMock({
      interaction_count: 5,
      native_language:   null,
      learned_patterns:  { 'hi-IN': 5 },
    });
    mockGetDb.mockReturnValue({ from: fromFn });

    await recordInteraction('user-001', 'hi-IN');

    expect(upsertFn).toHaveBeenCalledWith(
      expect.objectContaining({ interaction_count: 6 }),
      expect.anything(),
    );
  });
});
