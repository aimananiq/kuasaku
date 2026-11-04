/**
 * Jebat's Meta tools. They run on the server with the workspace id from the verified session; the model never sees a
 * token, an app secret or a Page token, and no tool here can turn paid spend on: activation exists only as a button
 * a person with `approve-ad-spend` presses (or a job scheduled after that approval).
 *
 * Reads run freely. Anything that writes to Meta or the database goes through the same approval card as every other
 * Jebat change (see `META_WRITE_TOOL_NAMES`).
 */
import 'server-only';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { can } from '@/lib/auth/permissions';
import { serviceClient } from '@/lib/supabase/service';
import { publicStatus } from '@/lib/meta/connection';
import * as api from '@/lib/meta/api';
import * as mk from '@/lib/meta/marketing';
import { ingestLead } from '@/lib/meta/leads';
import { BID_STRATEGIES, CTAS, FB_POSITIONS, OBJECTIVES, zonedToUtc } from '@/lib/meta/validate';

export const META_WRITE_TOOL_NAMES = [
  'create_facebook_post', 'cancel_facebook_post', 'create_ad_draft', 'attach_ad_image', 'build_paused_ad_on_meta',
  'request_ad_approval', 'pause_ad', 'schedule_ad_pause', 'sync_facebook_leads',
] as const;
export const META_READ_TOOL_NAMES = [
  'meta_connection_status', 'connect_meta_business', 'list_business_accounts', 'list_ad_accounts', 'list_facebook_pages',
  'list_facebook_posts', 'list_ad_drafts', 'get_ad_details', 'get_campaign_insights', 'get_ad_insights', 'get_lead_forms',
] as const;

export type MetaToolContext = { client: SupabaseClient; orgId: string; userId: string | null; role: string | null; canWrite: boolean };

const err = (error: string, extra: object = {}) => ({ ok: false as const, error, ...extra });
const when = z.object({
  local_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).describe('Wall-clock time in the given time zone, YYYY-MM-DDTHH:mm'),
  timezone: z.string().default('Asia/Kuala_Lumpur').describe('IANA time zone, e.g. Asia/Kuala_Lumpur'),
});
const range = z.object({
  date_preset: z.enum(['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month']).optional(),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export function createMetaTools(ctx: MetaToolContext): ToolSet {
  const manage = !!ctx.role && can(ctx.role as never, 'manage-ads-account');
  const uid = ctx.userId ?? '';
  const svc = () => serviceClient();
  const guard = (): string | null => (!ctx.canWrite ? 'Your role cannot make changes.' : !manage ? 'Only an owner or admin can change Meta ads and posts.' : null);
  // Insights and lists run against Meta with the workspace's own credential. Failures become readable text, never a token.
  const withMeta = async <T extends object>(fn: (c: api.MetaCtx) => Promise<T>) => {
    const m = await mk.metaContext(svc(), ctx.orgId);
    if (!m.ok) return err(m.error, { blocker: true });
    try { return { ok: true as const, ...(await fn(m.ctx)) }; } catch (e) { return err(await mk.metaFailure(svc(), ctx.orgId, e)); }
  };
  const rangeOf = (r: z.infer<typeof range>) => ({ datePreset: r.date_preset, since: r.since, until: r.until });

  return {
    meta_connection_status: tool({
      description: 'Shows whether Meta Business is connected for this workspace: business, ad account, Page, permissions, last check. Never returns credentials.',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, ...(await publicStatus(ctx.client)) }),
    }),

    connect_meta_business: tool({
      description: 'Use when the user asks to connect Meta. Connecting needs the user to sign in to Meta and approve access; this tool cannot connect on their behalf. It returns where to go.',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await publicStatus(ctx.client);
        return { ok: true, already_connected: s.connected, can_connect: manage, next_step: manage ? 'Open Jebat → Ad Settings → Connected account and choose "Connect Meta" (or, for a business-owned system user, enter its token there).' : 'An owner or admin must connect Meta in Jebat → Ad Settings.', connect_path: '/reach/ad-settings' };
      },
    }),

    list_business_accounts: tool({ description: 'Lists the Meta Business portfolios this connection can see.', inputSchema: z.object({}), execute: () => withMeta(async (c) => ({ businesses: await api.listBusinessAccounts(c) })) }),
    list_ad_accounts: tool({ description: 'Lists the ad accounts this connection can see (id, name, currency).', inputSchema: z.object({}), execute: () => withMeta(async (c) => ({ ad_accounts: (await api.listAdAccountsFor(c)).map((a) => ({ id: `act_${a.account_id}`, name: a.name, currency: a.currency })) })) }),
    list_facebook_pages: tool({ description: 'Lists the Facebook Pages this connection can manage.', inputSchema: z.object({}), execute: () => withMeta(async (c) => ({ pages: await api.listFacebookPages(c) })) }),

    list_facebook_posts: tool({
      description: 'Lists this workspace\'s Facebook Page posts and their status (draft, scheduled, published, failed) and pending publishing jobs.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      execute: async ({ limit }) => {
        const [{ data: posts }, { data: jobs }] = await Promise.all([
          ctx.client.from('meta_page_posts').select('id,kind,message,status,scheduled_at,published_at,fb_post_id,last_error,media_urls').order('created_at', { ascending: false }).limit(limit),
          ctx.client.from('meta_jobs').select('id,kind,target_id,run_at,status,attempts,last_error').in('status', ['pending', 'running', 'failed']).order('run_at').limit(50),
        ]);
        return { ok: true, posts: posts ?? [], jobs: jobs ?? [] };
      },
    }),

    create_facebook_post: tool({
      description: 'Creates a Facebook Page post (text, link, one image or several images from generate_image). mode "draft" saves it; "schedule" queues it for a local time; "publish_now" posts publicly right away. Needs approval.',
      inputSchema: z.object({
        message: z.string().max(5000).optional(), link: z.string().url().optional(),
        image_urls: z.array(z.string().url()).max(10).optional().describe('fal.ai image URLs from generate_image'),
        mode: z.enum(['draft', 'schedule', 'publish_now']).default('draft'),
        schedule: when.optional().describe('Required when mode is "schedule"'),
      }),
      execute: async (i) => {
        const g = guard(); if (g) return err(g);
        if (i.mode === 'schedule' && !i.schedule) return err('Give the local time to schedule the post.');
        const rec = await mk.createPostRecord(svc(), ctx.orgId, uid, { message: i.message, link: i.link, mediaUrls: i.image_urls, timezone: i.schedule?.timezone });
        if (!rec.ok) return rec;
        if (i.mode === 'draft') return { ok: true, post_id: rec.post.id, status: 'draft' };
        if (i.mode === 'schedule') {
          const at = zonedToUtc(i.schedule!.local_time, i.schedule!.timezone);
          if (!at) return err('That time or time zone is not valid.', { post_id: rec.post.id });
          const s = await mk.schedulePost(svc(), ctx.orgId, uid, rec.post.id, at, i.schedule!.timezone);
          return s.ok ? { ok: true, post_id: rec.post.id, status: 'scheduled', publishes_at_utc: at.toISOString(), job_id: s.jobId } : { ...s, post_id: rec.post.id };
        }
        const p = await mk.publishPost(svc(), ctx.orgId, rec.post.id, uid);
        return p.ok ? { ok: true, post_id: rec.post.id, status: 'published', facebook_post_id: p.fbPostId } : { ...p, post_id: rec.post.id };
      },
    }),

    cancel_facebook_post: tool({
      description: 'Cancels a draft or scheduled Facebook post by id. Needs approval.',
      inputSchema: z.object({ post_id: z.string().uuid() }),
      execute: async ({ post_id }) => { const g = guard(); return g ? err(g) : mk.cancelPost(svc(), ctx.orgId, uid, post_id); },
    }),

    create_ad_draft: tool({
      description: 'Prepares (does not spend or send to Meta) a paid Facebook ad: campaign, audience, budget, creative text and an optional fal.ai image URL. Budget is in the currency\'s smallest unit (RM 50.00 = 5000). Must respect the workspace spending cap. Needs approval.',
      inputSchema: z.object({
        name: z.string().min(1).max(200), objective: z.enum(OBJECTIVES),
        budget_type: z.enum(['daily', 'lifetime']).default('daily'), budget_minor: z.number().int().positive(), currency: z.string().length(3),
        start: when.optional(), end: when.optional(),
        countries: z.array(z.string().length(2)).min(1), age_min: z.number().int().min(18).max(65).optional(), age_max: z.number().int().min(18).max(65).optional(),
        placements: z.array(z.enum(FB_POSITIONS)).optional(), optimization_goal: z.string().optional(), bid_strategy: z.enum(BID_STRATEGIES).optional(),
        headline: z.string().max(40).optional(), primary_text: z.string().max(500).optional(), description: z.string().max(200).optional(),
        cta: z.enum(CTAS).optional(), link_url: z.string().url().optional(), lead_form_id: z.string().optional(), image_url: z.string().url().optional(),
      }),
      execute: async (i) => {
        const g = guard(); if (g) return err(g);
        const tz = i.start?.timezone ?? i.end?.timezone ?? 'Asia/Kuala_Lumpur';
        const s = i.start ? zonedToUtc(i.start.local_time, i.start.timezone) : null;
        const e = i.end ? zonedToUtc(i.end.local_time, i.end.timezone) : null;
        if ((i.start && !s) || (i.end && !e)) return err('A date or time zone is not valid.');
        const r = await mk.createAdDraft(svc(), ctx.orgId, uid, {
          name: i.name, objective: i.objective, budgetType: i.budget_type, budgetMinor: i.budget_minor, currency: i.currency, startsAt: s?.toISOString() ?? null, endsAt: e?.toISOString() ?? null,
          targeting: { countries: i.countries.map((c) => c.toUpperCase()), ageMin: i.age_min, ageMax: i.age_max }, placements: i.placements, optimizationGoal: i.optimization_goal, bidStrategy: i.bid_strategy,
          headline: i.headline, primaryText: i.primary_text, description: i.description, cta: i.cta, linkUrl: i.link_url, leadFormId: i.lead_form_id, imageUrl: i.image_url, timezone: tz,
        });
        if (!r.ok) return r;
        return { ok: true, draft_id: r.draft.id, status: r.draft.status, warnings: r.warnings, next: 'Ask the user to approve the image in Jebat → Ad Settings → Meta ad drafts, then build_paused_ad_on_meta.' };
      },
    }),

    attach_ad_image: tool({
      description: 'Attaches (or replaces) the fal.ai image on an ad draft that is not yet built on Meta. The image must be approved again by a person. Needs approval.',
      inputSchema: z.object({ draft_id: z.string().uuid(), image_url: z.string().url() }),
      execute: async (i) => { const g = guard(); return g ? err(g) : mk.attachImage(svc(), ctx.orgId, i.draft_id, i.image_url); },
    }),

    build_paused_ad_on_meta: tool({
      description: 'Creates the Campaign, Ad Set, uploads the approved image, and creates the Creative and Ad on Meta. Everything is created PAUSED and nothing is spent. Requires the ad image to have been approved by a person. Needs approval.',
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      execute: async ({ draft_id }) => {
        const g = guard(); if (g) return err(g);
        const r = await mk.buildOnMeta(svc(), ctx.orgId, uid, draft_id);
        return r.ok ? { ok: true, status: r.draft.status, meta_campaign_id: r.draft.meta_campaign_id, meta_adset_id: r.draft.meta_adset_id, meta_ad_id: r.draft.meta_ad_id, spending: false } : r;
      },
    }),

    request_ad_approval: tool({
      description: 'Asks the workspace\'s approvers to review and approve a built, paused ad. This does NOT activate it. Activation is done by a person in Ad Settings. Needs approval.',
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      execute: async ({ draft_id }) => {
        const g = guard(); if (g) return err(g);
        const r = await mk.requestApproval(svc(), ctx.orgId, uid, draft_id);
        return r.ok ? { ok: true, status: 'approval_requested', where: 'Jebat → Ad Settings → Meta ad drafts', spending: false } : r;
      },
    }),

    list_ad_drafts: tool({
      description: 'Lists the workspace\'s ad drafts with their status, budget and Meta ids. No credentials.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      execute: async ({ limit }) => {
        const { data } = await ctx.client.from('meta_ad_drafts').select('id,name,objective,status,budget_type,budget_minor,currency,image_status,meta_campaign_id,meta_ad_id,approval_expires_at,last_error').order('created_at', { ascending: false }).limit(limit);
        return { ok: true, drafts: data ?? [] };
      },
    }),

    get_ad_details: tool({
      description: 'Reads an ad\'s live status back from Meta (status, delivery status, review issues).',
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      execute: async ({ draft_id }) => {
        const d = await mk.getDraft(svc(), ctx.orgId, draft_id);
        if (!d?.meta_ad_id) return err('That draft is not built on Meta yet.');
        return withMeta(async (c) => ({ ad: await api.getAdStatus(c, d.meta_ad_id!) }));
      },
    }),

    pause_ad: tool({
      description: 'Pauses an ad draft\'s campaign, ad set and ad on Meta. Pausing only stops spend. Needs approval.',
      inputSchema: z.object({ draft_id: z.string().uuid() }),
      execute: async ({ draft_id }) => { const g = guard(); return g ? err(g) : mk.pauseDraft(svc(), ctx.orgId, draft_id, uid); },
    }),

    schedule_ad_pause: tool({
      description: 'Schedules an ad to be paused at a local date and time (for example at the end date). Needs approval.',
      inputSchema: z.object({ draft_id: z.string().uuid(), at: when }),
      execute: async ({ draft_id, at }) => {
        const g = guard(); if (g) return err(g);
        const t = zonedToUtc(at.local_time, at.timezone);
        if (!t || t.getTime() < Date.now()) return err('Choose a valid time in the future.');
        const d = await mk.getDraft(svc(), ctx.orgId, draft_id);
        if (!d?.meta_campaign_id) return err('That draft is not built on Meta yet.');
        const r = await mk.enqueue(svc(), ctx.orgId, uid, 'pause_ad', draft_id, t, at.timezone);
        return r.ok ? { ok: true, job_id: r.jobId, pauses_at_utc: t.toISOString() } : r;
      },
    }),

    get_campaign_insights: tool({
      description: 'Performance per campaign from Meta: spend, impressions, reach, clicks, CPC, CPM, CTR, leads (Meta\'s `lead` action) and cost per lead, for a date preset or a range. Read-only.',
      inputSchema: range,
      execute: (r) => withMeta(async (c) => ({ level: 'campaign', rows: await api.getCampaignInsights(c, rangeOf(r)), note: 'Currency is the ad account\'s. Leads use Meta\'s default attribution window.' })),
    }),
    get_ad_insights: tool({
      description: 'Performance per ad from Meta (same metrics as get_campaign_insights). Use it to find the ad with the lowest cost per lead. Read-only.',
      inputSchema: range,
      execute: (r) => withMeta(async (c) => ({ level: 'ad', rows: await api.getAdInsights(c, rangeOf(r)), note: 'Currency is the ad account\'s. Leads use Meta\'s default attribution window.' })),
    }),

    get_lead_forms: tool({
      description: 'Lists the Page\'s Lead Ad forms. Needs the leads_retrieval permission (Meta App Review); otherwise explains the blocker.',
      inputSchema: z.object({}),
      execute: async () => {
        const s = await publicStatus(ctx.client);
        if (s.connected && !s.permissions.includes('leads_retrieval')) return err('Lead forms need the leads_retrieval permission, which this connection does not have. Meta requires App Review for it.', { blocker: true });
        return withMeta(async (c) => ({ forms: await api.getLeadForms(c) }));
      },
    }),

    sync_facebook_leads: tool({
      description: 'Pulls recent submissions of one Lead Ad form from Meta into Kasturi (contact, deal, follow-up task). Already-imported leads are skipped. Needs leads_retrieval. Needs approval.',
      inputSchema: z.object({ form_id: z.string().regex(/^\d{5,30}$/), max: z.number().int().min(1).max(200).default(50) }),
      execute: async ({ form_id, max }) => {
        const g = guard(); if (g) return err(g);
        const s = await publicStatus(ctx.client);
        if (!s.permissions.includes('leads_retrieval')) return err('Syncing leads needs the leads_retrieval permission, which this connection does not have. Meta requires App Review for it.', { blocker: true });
        const m = await mk.metaContext(svc(), ctx.orgId);
        if (!m.ok) return m;
        try {
          const leads = await api.listFormLeads(m.ctx, form_id, max);
          const tally = { created: 0, linked_existing: 0, duplicate: 0, error: 0 };
          for (const l of leads) tally[(await ingestLead(svc(), ctx.orgId, l)).status]++;
          return { ok: true, fetched: leads.length, ...tally };
        } catch (e) { return err(await mk.metaFailure(svc(), ctx.orgId, e)); }
      },
    }),
  };
}
