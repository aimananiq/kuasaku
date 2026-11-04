import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { backoffMs, configHash, postKind, validateDraft, validatePost, zonedToUtc, type DraftInput } from '@/lib/meta/validate';

const policy = { maxDailyMinor: 10_000, maxLifetimeMinor: 100_000, currency: 'MYR' };
const base: DraftInput = {
  name: 'Young Lecturer Programme', objective: 'traffic', budgetType: 'daily', budgetMinor: 5000, currency: 'MYR',
  targeting: { countries: ['MY'], ageMin: 25, ageMax: 45 }, linkUrl: 'https://example.com/ylp', headline: 'Teach the future',
};

describe('ad draft validation', () => {
  it('accepts a sound draft', () => expect(validateDraft(base, policy)).toEqual([]));
  it('enforces the workspace budget cap', () => expect(validateDraft({ ...base, budgetMinor: 10_001 }, policy).join()).toMatch(/exceeds the workspace limit/));
  it('requires the workspace currency', () => expect(validateDraft({ ...base, currency: 'USD' }, policy).join()).toMatch(/MYR/));
  it('requires an end date for a lifetime budget', () => expect(validateDraft({ ...base, budgetType: 'lifetime' }, policy).join()).toMatch(/end date/));
  it('rejects goals that do not belong to the objective', () => expect(validateDraft({ ...base, optimizationGoal: 'LEAD_GENERATION' }, policy).join()).toMatch(/not valid for the traffic/));
  it('blocks sales objective that needs a pixel', () => expect(validateDraft({ ...base, objective: 'sales' }, policy).join()).toMatch(/Pixel/));
  it('rejects non-https destinations and bad countries/ages', () => {
    expect(validateDraft({ ...base, linkUrl: 'http://x.com' }, policy).join()).toMatch(/https/);
    expect(validateDraft({ ...base, targeting: { countries: ['Malaysia'] } }, policy).join()).toMatch(/country/);
    expect(validateDraft({ ...base, targeting: { countries: ['MY'], ageMin: 50, ageMax: 30 } }, policy).join()).toMatch(/cannot exceed/);
  });
});

describe('post validation', () => {
  const now = new Date('2026-11-04T00:00:00Z');
  it('needs content and a future schedule', () => {
    expect(validatePost({}, now).length).toBeGreaterThan(0);
    expect(validatePost({ message: 'hi', scheduledAt: '2026-11-03T00:00:00Z' }, now).join()).toMatch(/future/);
    expect(validatePost({ message: 'hi', scheduledAt: '2026-11-05T00:00:00Z' }, now)).toEqual([]);
  });
  it('rejects http media and link plus images together', () => {
    expect(validatePost({ mediaUrls: ['http://a.com/x.png'] }, now).join()).toMatch(/https/);
    expect(validatePost({ link: 'https://a.com', mediaUrls: ['https://a.com/x.png'] }, now).join()).toMatch(/not both/);
  });
  it('classifies post kinds', () => {
    expect(postKind({})).toBe('text');
    expect(postKind({ link: 'https://a.com' })).toBe('link');
    expect(postKind({ mediaUrls: ['a'] })).toBe('image');
    expect(postKind({ mediaUrls: ['a', 'b'] })).toBe('multi_image');
  });
});

describe('helpers', () => {
  it('hashes material settings and changes with them', () => {
    const a = configHash({ budget_minor: 5000, targeting: { countries: ['MY'] } });
    expect(configHash({ targeting: { countries: ['MY'] }, budget_minor: 5000 })).toBe(a);
    expect(configHash({ budget_minor: 5001, targeting: { countries: ['MY'] } })).not.toBe(a);
  });
  it('backs off exponentially with a ceiling', () => {
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(3)).toBe(240_000);
    expect(backoffMs(20)).toBe(30 * 60_000);
  });
  it('reads wall-clock time in the user zone (Kuala Lumpur is UTC+8)', () => {
    expect(zonedToUtc('2026-11-05T09:00', 'Asia/Kuala_Lumpur')?.toISOString()).toBe('2026-11-05T01:00:00.000Z');
    expect(zonedToUtc('nope', 'Asia/Kuala_Lumpur')).toBeNull();
    expect(zonedToUtc('2026-11-05T09:00', 'Not/AZone')).toBeNull();
  });
});
