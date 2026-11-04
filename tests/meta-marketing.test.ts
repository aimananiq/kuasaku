import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './helpers/fake-supabase';

vi.mock('server-only', () => ({}));
const FAL = 'https://v3.fal.media/files/a/b.png';
const ORG = 'org-1';

const conn = { state: 'ok', token: 'SECRET_TOKEN', method: 'oauth', status: 'connected', adAccountId: 'act_12345', pageId: '99999', apiVersion: 'v23.0', expiresAt: null };
vi.mock('@/lib/meta/connection', () => ({ openConnection: vi.fn(async () => conn), markStatus: vi.fn(), audit: vi.fn() }));
const api = vi.hoisted(() => ({
  createFacebookPost: vi.fn(async () => ({ id: '99999_111' })), findRecentPost: vi.fn(async () => null),
  createAdCampaign: vi.fn(async () => 'camp1'), createAdSet: vi.fn(async () => 'set1'), uploadAdImage: vi.fn(async () => ({ hash: 'h1' })),
  createAdCreative: vi.fn(async () => 'cre1'), createFacebookAd: vi.fn(async () => 'ad1'), updateAdStatus: vi.fn(async () => undefined),
}));
vi.mock('@/lib/meta/api', () => api);

import * as mk from '@/lib/meta/marketing';

const draftInput = {
  name: 'YLP', objective: 'traffic' as const, budgetType: 'daily' as const, budgetMinor: 5000, currency: 'MYR',
  targeting: { countries: ['MY'] }, linkUrl: 'https://example.com/ylp', headline: 'Teach', imageUrl: FAL,
};
const newDb = (caps: object | null = { org_id: ORG, daily_cap_cents: 10_000, monthly_cap_cents: 100_000, currency: 'MYR' }) => fakeSupabase({ ad_settings: caps ? [caps as never] : [] }, { meta_jobs: [['idempotency_key']] });

async function builtDraft(db: ReturnType<typeof newDb>) {
  const r = await mk.createAdDraft(db, ORG, 'u1', draftInput);
  if (!r.ok) throw new Error(r.error);
  await mk.setImageDecision(db, ORG, 'u1', r.draft.id, 'approved');
  const b = await mk.buildOnMeta(db, ORG, 'u1', r.draft.id);
  expect(b.ok).toBe(true);
  return r.draft.id;
}

beforeEach(() => vi.clearAllMocks());

describe('Test B — Facebook Page posts', () => {
  it('drafts, schedules, publishes once, and never publishes the same post twice', async () => {
    const db = newDb();
    const rec = await mk.createPostRecord(db, ORG, 'u1', { message: 'Hello', mediaUrls: [FAL] });
    expect(rec.ok && rec.post.status).toBe('draft');
    const id = (rec as { post: { id: string } }).post.id;
    const sched = await mk.schedulePost(db, ORG, 'u1', id, new Date(Date.now() + 3600_000), 'Asia/Kuala_Lumpur');
    expect(sched.ok).toBe(true);
    expect(db.tables.meta_page_posts[0].status).toBe('scheduled');

    const first = await mk.publishPost(db, ORG, id, 'u1');
    const second = await mk.publishPost(db, ORG, id, 'u1');
    expect(first).toMatchObject({ ok: true, fbPostId: '99999_111' });
    expect(second).toMatchObject({ ok: true, fbPostId: '99999_111' });
    expect(api.createFacebookPost).toHaveBeenCalledTimes(1);
  });
  it('rejects images that did not come from fal.ai', async () => {
    const r = await mk.createPostRecord(newDb(), ORG, 'u1', { message: 'x', mediaUrls: ['https://evil.example/x.png'] });
    expect(r.ok).toBe(false);
  });
  it('a retried job finds a post that already reached Meta instead of posting again', async () => {
    const db = newDb();
    const rec = await mk.createPostRecord(db, ORG, 'u1', { message: 'Hello' });
    const id = (rec as { post: { id: string } }).post.id;
    db.tables.meta_page_posts[0].attempts = 1; // a previous attempt may have succeeded unseen
    api.findRecentPost.mockResolvedValueOnce('99999_222' as never);
    const r = await mk.publishPost(db, ORG, id, 'u1');
    expect(r).toMatchObject({ ok: true, fbPostId: '99999_222' });
    expect(api.createFacebookPost).not.toHaveBeenCalled();
  });
  it('cancelling stops a scheduled post and its job', async () => {
    const db = newDb();
    const id = ((await mk.createPostRecord(db, ORG, 'u1', { message: 'Hi' })) as { post: { id: string } }).post.id;
    await mk.schedulePost(db, ORG, 'u1', id, new Date(Date.now() + 3600_000), 'Asia/Kuala_Lumpur');
    expect((await mk.cancelPost(db, ORG, 'u1', id)).ok).toBe(true);
    expect(db.tables.meta_jobs.every((j: Record<string, unknown>) => j.status === 'cancelled')).toBe(true);
  });
  it('scheduling the same time twice makes one job', async () => {
    const db = newDb();
    const at = new Date(Date.now() + 3600_000);
    await mk.enqueue(db, ORG, 'u1', 'publish_post', 'p1', at, 'UTC');
    await mk.enqueue(db, ORG, 'u1', 'publish_post', 'p1', at, 'UTC');
    expect(db.tables.meta_jobs).toHaveLength(1);
  });
});

describe('Test C — paid ads', () => {
  it('refuses to prepare a draft when the workspace has set no spending cap', async () => {
    const r = await mk.createAdDraft(newDb(null), ORG, 'u1', draftInput);
    expect(r).toMatchObject({ ok: false, blocker: true });
  });
  it('refuses a budget above the cap', async () => {
    const r = await mk.createAdDraft(newDb(), ORG, 'u1', { ...draftInput, budgetMinor: 10_001 });
    expect(r.ok).toBe(false);
  });
  it('will not build on Meta before a person approves the image', async () => {
    const db = newDb();
    const d = await mk.createAdDraft(db, ORG, 'u1', draftInput);
    const r = await mk.buildOnMeta(db, ORG, 'u1', (d as { draft: { id: string } }).draft.id);
    expect(r.ok).toBe(false);
    expect(api.createAdCampaign).not.toHaveBeenCalled();
  });
  it('builds campaign → ad set → image → creative → ad, resumably, and spends nothing', async () => {
    const db = newDb();
    await builtDraft(db);
    expect(api.createAdCampaign).toHaveBeenCalledTimes(1);
    expect(api.updateAdStatus).not.toHaveBeenCalled();
    expect(db.tables.meta_ad_drafts[0]).toMatchObject({ status: 'created_paused', meta_campaign_id: 'camp1', meta_adset_id: 'set1', meta_creative_id: 'cre1', meta_ad_id: 'ad1' });
  });
  it('resumes a half-built ad without creating a second campaign', async () => {
    const db = newDb();
    const id = ((await mk.createAdDraft(db, ORG, 'u1', draftInput)) as { draft: { id: string } }).draft.id;
    await mk.setImageDecision(db, ORG, 'u1', id, 'approved');
    api.createAdSet.mockRejectedValueOnce(new Error('boom'));
    expect((await mk.buildOnMeta(db, ORG, 'u1', id)).ok).toBe(false);
    expect((await mk.buildOnMeta(db, ORG, 'u1', id)).ok).toBe(true);
    expect(api.createAdCampaign).toHaveBeenCalledTimes(1);
  });
});

describe('Test F — paid activation requires approval', () => {
  it('cannot be activated straight from paused', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    expect((await mk.activateDraft(db, ORG, id, { via: 'user' })).ok).toBe(false);
    expect(api.updateAdStatus).not.toHaveBeenCalled();
  });
  it('cannot be activated when only approval was requested', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    await mk.requestApproval(db, ORG, 'u1', id);
    expect((await mk.activateDraft(db, ORG, id, { via: 'schedule' })).ok).toBe(false);
  });
  it('rejects an approval for settings other than the ones the approver saw', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    await mk.requestApproval(db, ORG, 'u1', id);
    expect((await mk.approveDraft(db, ORG, 'boss', id, 'stale-hash')).ok).toBe(false);
  });
  it('activates campaign, ad set and ad exactly once after approval', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    const asked = await mk.requestApproval(db, ORG, 'u1', id);
    const hash = (asked as { draft: { config_hash: string } }).draft.config_hash;
    expect((await mk.approveDraft(db, ORG, 'boss', id, hash)).ok).toBe(true);
    expect((await mk.activateDraft(db, ORG, id, { via: 'user' })).ok).toBe(true);
    expect(api.updateAdStatus.mock.calls.map((c: unknown[]) => c[2])).toEqual(['ACTIVE', 'ACTIVE', 'ACTIVE']);
    const again = await mk.activateDraft(db, ORG, id, { via: 'user' });
    expect(again.ok).toBe(false);
    expect(api.updateAdStatus).toHaveBeenCalledTimes(3);
  });
  it('an expired approval cannot activate', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    const hash = ((await mk.requestApproval(db, ORG, 'u1', id)) as { draft: { config_hash: string } }).draft.config_hash;
    await mk.approveDraft(db, ORG, 'boss', id, hash);
    db.tables.meta_ad_drafts[0].approval_expires_at = new Date(Date.now() - 1000).toISOString();
    expect((await mk.activateDraft(db, ORG, id, { via: 'schedule' })).ok).toBe(false);
  });
  it('a budget edited after approval invalidates it', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    const hash = ((await mk.requestApproval(db, ORG, 'u1', id)) as { draft: { config_hash: string } }).draft.config_hash;
    await mk.approveDraft(db, ORG, 'boss', id, hash);
    db.tables.meta_ad_drafts[0].budget_minor = 9000;
    expect((await mk.activateDraft(db, ORG, id, { via: 'user' })).ok).toBe(false);
    expect(api.updateAdStatus).not.toHaveBeenCalled();
  });
  it('lowering the workspace cap after approval blocks activation', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    const hash = ((await mk.requestApproval(db, ORG, 'u1', id)) as { draft: { config_hash: string } }).draft.config_hash;
    await mk.approveDraft(db, ORG, 'boss', id, hash);
    db.tables.ad_settings[0].daily_cap_cents = 1000;
    expect((await mk.activateDraft(db, ORG, id, { via: 'user' })).ok).toBe(false);
  });
  it('a scheduled activation job runs only through the same checks, and an unapproved one fails without retrying', async () => {
    const db = newDb();
    const id = await builtDraft(db);
    db.tables.meta_jobs = [{ id: 'j1', org_id: ORG, kind: 'activate_ad', target_id: id, attempts: 1, max_attempts: 5, created_by: 'u1' }];
    db.rpc = async () => ({ data: db.tables.meta_jobs.filter((j: Record<string, unknown>) => j.status !== 'failed' && j.status !== 'done'), error: null });
    const tally = await mk.runDueJobs(db);
    expect(tally.failed).toBe(1);
    expect(api.updateAdStatus).not.toHaveBeenCalled();
  });
});
