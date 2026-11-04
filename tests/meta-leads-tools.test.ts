import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './helpers/fake-supabase';

vi.mock('server-only', () => ({}));
const hoisted = vi.hoisted(() => ({ fetchCalls: [] as { url: string; init: RequestInit }[] }));
vi.mock('@/lib/meta/connection', () => ({
  openConnection: vi.fn(async () => ({ state: 'ok', token: 'SECRET_TOKEN', method: 'oauth', status: 'connected', adAccountId: 'act_12345', pageId: '99999', apiVersion: 'v23.0', expiresAt: null })),
  markStatus: vi.fn(), audit: vi.fn(),
  publicStatus: vi.fn(async () => ({ connected: true, status: 'connected', permissions: ['ads_management'], businessName: 'B', adAccountId: 'act_12345', adAccountName: 'A', pageId: '99999', pageName: 'P', method: 'oauth', tokenExpiresAt: null, lastValidatedAt: null, lastError: null })),
}));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => svc.db }));
const svc = vi.hoisted(() => ({ db: null as unknown }));

import { ingestLead, mapLeadFields, parseLeadgenPayload, verifyWebhookSignature } from '@/lib/meta/leads';
import * as api from '@/lib/meta/api';
import { createMetaTools, META_READ_TOOL_NAMES, META_WRITE_TOOL_NAMES } from '@/lib/ai/meta-tools';

const lead = { id: '123456789', form_id: '5550001', campaign_id: 'c1', created_time: '2026-11-04T01:00:00Z', field_data: [{ name: 'full_name', values: ['Aiman Aniq'] }, { name: 'email', values: ['Aiman@Example.com'] }, { name: 'phone_number', values: ['+60123456789'] }] };
const crmDb = () => fakeSupabase(
  { crm_pipelines: [{ id: 'pipe1', org_id: 'o', is_default: true }], crm_pipeline_stages: [{ id: 'st1', pipeline_id: 'pipe1', position: 1 }] },
  { meta_lead_ingest: [['org_id', 'leadgen_id']] },
);

describe('Test E — Meta lead → Kasturi', () => {
  it('verifies webhook signatures and rejects bad ones', () => {
    const body = JSON.stringify({ a: 1 });
    const sig = 'sha256=' + createHmac('sha256', 'appsecret').update(body).digest('hex');
    expect(verifyWebhookSignature(body, sig, 'appsecret')).toBe(true);
    expect(verifyWebhookSignature(body + ' ', sig, 'appsecret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, 'other')).toBe(false);
    expect(verifyWebhookSignature(body, null, 'appsecret')).toBe(false);
    expect(verifyWebhookSignature(body, sig, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, 'sha256=zz', 'appsecret')).toBe(false);
  });
  it('parses only leadgen changes with sane ids', () => {
    const body = { object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '123456789', page_id: '99999', form_id: '5550001' } }, { field: 'feed', value: {} }, { field: 'leadgen', value: { leadgen_id: 'x; drop', page_id: '99999' } }] }] };
    expect(parseLeadgenPayload(body)).toEqual([{ leadgenId: '123456789', pageId: '99999', formId: '5550001', adId: null }]);
    expect(parseLeadgenPayload({ object: 'user', entry: [] })).toEqual([]);
  });
  it('maps fields and keeps only what the CRM has a place for', () => {
    expect(mapLeadFields(lead.field_data)).toMatchObject({ firstName: 'Aiman', lastName: 'Aniq', email: 'aiman@example.com', phone: '+60123456789' });
  });
  it('stores the lead as contact + deal + follow-up task, and ignores a repeated delivery', async () => {
    const db = crmDb();
    expect((await ingestLead(db, 'o', lead)).status).toBe('created');
    expect(db.tables.crm_contacts).toHaveLength(1);
    expect(db.tables.crm_contacts[0]).toMatchObject({ source: 'Facebook Lead Ad', status: 'lead' });
    expect(db.tables.crm_deals).toHaveLength(1);
    expect(db.tables.crm_activities[0]).toMatchObject({ type: 'task' });
    expect((await ingestLead(db, 'o', lead)).status).toBe('duplicate');
    expect(db.tables.crm_contacts).toHaveLength(1);
    expect(db.tables.crm_activities).toHaveLength(1);
  });
  it('attaches a new lead to an existing contact with the same email instead of duplicating', async () => {
    const db = crmDb();
    db.tables.crm_contacts = [{ id: 'existing', org_id: 'o', email: 'aiman@example.com' }];
    const r = await ingestLead(db, 'o', { ...lead, id: '987654321' });
    expect(r).toMatchObject({ status: 'linked_existing', contactId: 'existing' });
    expect(db.tables.crm_contacts).toHaveLength(1);
  });
  it('keeps the same lead id separate per workspace', async () => {
    const db = crmDb();
    await ingestLead(db, 'o1', lead);
    expect((await ingestLead(db, 'o2', lead)).status).toBe('created');
  });
});

describe('Meta API layer', () => {
  const ctx = (f: typeof fetch): api.MetaCtx => ({ token: 'SECRET_TOKEN', version: 'v23.0', adAccountId: 'act_12345', pageId: '99999', fetchImpl: f, sleep: async () => {} });
  const recorder = () => {
    hoisted.fetchCalls.length = 0;
    return vi.fn(async (url: URL | string, init?: RequestInit) => {
      hoisted.fetchCalls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: '1', access_token: 'PAGE_TOKEN' }), { status: 200 });
    }) as unknown as typeof fetch;
  };
  it('creates campaign, ad set and ad PAUSED, with the token only in the header', async () => {
    const f = recorder(); const c = ctx(f);
    await api.createAdCampaign(c, { name: 'n', objective: 'traffic' });
    await api.createAdSet(c, { campaignId: '1', name: 'n', objective: 'traffic', budgetType: 'daily', budgetMinor: 5000, countries: ['MY'] });
    await api.createFacebookAd(c, { name: 'n', adSetId: '1', creativeId: '2' });
    for (const call of hoisted.fetchCalls) {
      expect(JSON.parse(String(call.init.body)).status).toBe('PAUSED');
      expect(call.url).not.toContain('SECRET_TOKEN');
    }
    expect(JSON.parse(String(hoisted.fetchCalls[0].init.body)).objective).toBe('OUTCOME_TRAFFIC');
  });
  it('refuses to upload an ad image that is not hosted by fal.ai', async () => {
    await expect(api.uploadAdImage(ctx(recorder()), 'https://evil.example/x.png')).rejects.toThrow(/fal\.ai/);
  });
  it('maps insights including cost per lead', () => {
    const r = api.mapInsight({ campaign_id: 'c', campaign_name: 'C', spend: '50.00', impressions: '1000', clicks: '40', actions: [{ action_type: 'lead', value: '5' }] }, 'campaign');
    expect(r).toMatchObject({ spend: 50, leads: 5, costPerLead: 10 });
    expect(api.mapInsight({ spend: '10' }, 'ad').costPerLead).toBeNull();
  });
});

describe('Test D / F — Jebat tools', () => {
  beforeEach(() => { svc.db = fakeSupabase(); });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (role: string, canWrite = true) => createMetaTools({ client: fakeSupabase() as never, orgId: 'org-1', userId: 'u1', role, canWrite }) as Record<string, any>;

  it('registers every Meta read and write tool with an input schema', () => {
    const t = tools('owner');
    for (const n of [...META_READ_TOOL_NAMES, ...META_WRITE_TOOL_NAMES]) {
      expect(t[n], n).toBeDefined();
      expect(t[n].inputSchema, n).toBeDefined();
      expect(typeof t[n].execute, n).toBe('function');
    }
  });
  it('has no tool that activates paid ads or approves spend', () => {
    const names = Object.keys(tools('owner'));
    expect(names.filter((n) => /activate|approve_ad|enable/.test(n))).toEqual([]);
    expect(META_WRITE_TOOL_NAMES).not.toContain('activate_ad' as never);
  });
  it('every write tool is flagged for the approval card', () => {
    expect(META_WRITE_TOOL_NAMES).toEqual(expect.arrayContaining(['create_facebook_post', 'create_ad_draft', 'build_paused_ad_on_meta', 'request_ad_approval', 'pause_ad']));
  });
  it('a member or viewer cannot change posts or ads', async () => {
    for (const role of ['member', 'viewer']) {
      const t = tools(role, role !== 'viewer');
      const r = await t.create_facebook_post.execute({ message: 'hi', mode: 'publish_now' }, {});
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/owner or admin|cannot make changes/);
    }
  });
  it('connect_meta_business directs the user to the real flow and returns no credentials', async () => {
    const r = await tools('owner').connect_meta_business.execute({}, {});
    expect(r).toMatchObject({ ok: true, connect_path: '/reach/ad-settings' });
    expect(JSON.stringify(r)).not.toMatch(/SECRET_TOKEN|access_token/);
  });
  it('lead sync reports the missing permission as a blocker instead of faking leads', async () => {
    const r = await tools('owner').sync_facebook_leads.execute({ form_id: '5550001', max: 5 }, {});
    expect(r).toMatchObject({ ok: false, blocker: true });
    expect(r.error).toMatch(/leads_retrieval/);
  });
  it('a draft needs a spending cap first (no cap, no spend)', async () => {
    const r = await tools('owner').create_ad_draft.execute({ name: 'x', objective: 'traffic', budget_type: 'daily', budget_minor: 5000, currency: 'MYR', countries: ['MY'], link_url: 'https://example.com' }, {});
    expect(r.ok).toBe(false);
  });
});
