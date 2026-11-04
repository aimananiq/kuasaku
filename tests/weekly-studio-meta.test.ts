import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './helpers/fake-supabase';

vi.mock('server-only', () => ({}));
const org = vi.hoisted(() => ({ current: { orgId: 'o1', role: 'owner' } as { orgId: string; role: string } | null }));
vi.mock('@/lib/auth/current-org', () => ({ getCurrentOrg: vi.fn(async () => org.current) }));
const mk = vi.hoisted(() => ({ createPostRecord: vi.fn(async () => ({ ok: true, post: { id: 'post-1', status: 'draft' } })), publishPost: vi.fn() }));
vi.mock('@/lib/meta/marketing', () => mk);
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({}) }));

import { reachAgent } from '@/lib/agents/reach-agent';
import { runProposalAction } from '@/lib/agents/apply-proposal';
import { approvalDetail, approvalTitle } from '@/lib/chat/change-titles';

const built = { context: 'c', raw: {}, trend: 'angles' };
const connected = { org_id: 'o1', status: 'connected', page_id: '99999' };
const offers = async (db: ReturnType<typeof fakeSupabase>, b = built) =>
  (await reachAgent.extraCandidates!(db, 'o1', b, new Date())).map((c) => c.action);

beforeEach(() => { vi.clearAllMocks(); org.current = { orgId: 'o1', role: 'owner' }; });

describe('Weekly Studio → Facebook post drafts', () => {
  it('offers a post draft when a Page is connected and a trend exists', async () => {
    expect(await offers(fakeSupabase({ org_meta_connections: [connected] }))).toContain('createFacebookPostDraft');
  });
  it('offers nothing about Facebook when Meta is not connected, has no Page, or there is no trend', async () => {
    expect(await offers(fakeSupabase())).not.toContain('createFacebookPostDraft');
    expect(await offers(fakeSupabase({ org_meta_connections: [{ ...connected, page_id: null }] }))).not.toContain('createFacebookPostDraft');
    expect(await offers(fakeSupabase({ org_meta_connections: [{ ...connected, status: 'token_expired' }] }))).not.toContain('createFacebookPostDraft');
    expect(await offers(fakeSupabase({ org_meta_connections: [connected] }), { ...built, trend: undefined as never })).toEqual([]);
  });
  it('offers at most one a week', async () => {
    const db = fakeSupabase({ org_meta_connections: [connected], agent_proposals: [{ org_id: 'o1', action: 'createFacebookPostDraft', created_at: new Date().toISOString() }] });
    expect(await offers(db)).not.toContain('createFacebookPostDraft');
  });
  it('builds the proposal from the text the model wrote and shows it to the owner', async () => {
    const c = (await reachAgent.extraCandidates!(fakeSupabase({ org_meta_connections: [connected] }), 'o1', built, new Date())).find((x) => x.action === 'createFacebookPostDraft')!;
    const input = c.fillInput!('  Open day this Saturday — come and see our programmes!  ');
    expect(input).toEqual({ message: 'Open day this Saturday — come and see our programmes!' });
    expect(reachAgent.actions.createFacebookPostDraft.schema.safeParse(input).success).toBe(true);
    expect(reachAgent.actions.createFacebookPostDraft.schema.safeParse(c.fillInput!(undefined)).success).toBe(false);
    expect(c.detailFor!(input)).toContain('Open day this Saturday');
    expect(approvalTitle('createFacebookPostDraft', input)).toMatch(/draft/);
    expect(approvalDetail('createFacebookPostDraft', input)).toMatch(/nothing is posted/);
  });
  it('approving saves a draft only, and never publishes', async () => {
    const r = await runProposalAction('reach', { client: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }, orgId: 'o1' }, 'createFacebookPostDraft', { message: 'Hello everyone, new intake open now.' });
    expect(r).toMatchObject({ ok: true });
    expect(mk.createPostRecord).toHaveBeenCalledTimes(1);
    expect(mk.publishPost).not.toHaveBeenCalled();
  });
  it('a member or another workspace cannot save the draft', async () => {
    org.current = { orgId: 'o1', role: 'member' };
    expect(await runProposalAction('reach', { client: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }, orgId: 'o1' }, 'createFacebookPostDraft', { message: 'Hello everyone, new intake open.' })).toMatchObject({ ok: false });
    org.current = { orgId: 'other', role: 'owner' };
    expect(await runProposalAction('reach', { client: { auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) } }, orgId: 'o1' }, 'createFacebookPostDraft', { message: 'Hello everyone, new intake open.' })).toMatchObject({ ok: false });
    expect(mk.createPostRecord).not.toHaveBeenCalled();
  });
});
