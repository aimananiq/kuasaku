/**
 * Meta operations used by the tools, the scheduler and the UI. Server-only. Built on `graph()`, so every call has the
 * same auth, retry, pagination and error handling, and none puts a token in a URL.
 *
 * Every paid object (campaign, ad set, ad) is created PAUSED here and nowhere else sets ACTIVE except `setStatus`,
 * which only the approval path calls.
 */
import 'server-only';
import {
  graph, graphAll, grantedPermissions, listAdAccounts, listBusinesses, listPages,
  MetaApiError, type GraphOptions, type MetaAdAccount, type MetaBusiness, type MetaPage,
} from './graph';
import { OBJECTIVE_API, GOALS, type Objective } from './validate';
import { validateFalImageOrigin } from '@/lib/ai/fal-provider';

export type MetaCtx = { token: string; version: string; adAccountId: string | null; pageId: string | null; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> };
const o = (c: MetaCtx): GraphOptions => ({ token: c.token, version: c.version, fetchImpl: c.fetchImpl, sleep: c.sleep });

const needAd = (c: MetaCtx) => { if (!c.adAccountId) throw new MetaApiError('Select an ad account first.', 'invalid', 400); return c.adAccountId; };
const needPage = (c: MetaCtx) => { if (!c.pageId) throw new MetaApiError('Select a Facebook Page first.', 'invalid', 400); return c.pageId; };

// ---- discovery & validation ----------------------------------------------------------------------------------------
export const listBusinessAccounts = (c: MetaCtx): Promise<MetaBusiness[]> => listBusinesses(o(c));
export const listAdAccountsFor = (c: MetaCtx): Promise<MetaAdAccount[]> => listAdAccounts(o(c));
export const listFacebookPages = (c: MetaCtx): Promise<MetaPage[]> => listPages(o(c));

/** Token is live, permissions are as granted, and the chosen assets are really reachable (scope alone is not access). */
export async function validateMetaConnection(c: MetaCtx) {
  const permissions = await grantedPermissions(o(c));
  const problems: string[] = [];
  if (c.adAccountId) await graph(`/${c.adAccountId}`, { ...o(c), query: { fields: 'id' } }).catch(() => problems.push('The selected ad account is not accessible.'));
  if (c.pageId) await graph(`/${c.pageId}`, { ...o(c), query: { fields: 'id' } }).catch(() => problems.push('The selected Page is not accessible.'));
  return { permissions, problems };
}

/** Pages are published with the Page's own token, read from the user/system-user token. Never stored or returned. */
async function pageToken(c: MetaCtx): Promise<string> {
  const r = await graph<{ access_token?: string }>(`/${needPage(c)}`, { ...o(c), query: { fields: 'access_token' } });
  if (!r.access_token) throw new MetaApiError('This connection cannot publish to the Page (no Page access).', 'permission', 403);
  return r.access_token;
}

// ---- organic posts -------------------------------------------------------------------------------------------------
export type PostInput = { message?: string | null; link?: string | null; mediaUrls?: string[] };

/** Publishes now. Returns the Facebook post id. */
export async function createFacebookPost(c: MetaCtx, i: PostInput): Promise<{ id: string }> {
  const page = needPage(c);
  // No automatic retry on publish: a 5xx can arrive after Meta accepted the post. The job queue retries with a check instead.
  const po = { ...o(c), token: await pageToken(c), retries: 0 };
  const media = i.mediaUrls ?? [];
  if (media.length === 0) {
    const r = await graph<{ id: string }>(`/${page}/feed`, { ...po, method: 'POST', body: { message: i.message ?? undefined, link: i.link ?? undefined } });
    return { id: r.id };
  }
  if (media.length === 1) {
    const r = await graph<{ id: string; post_id?: string }>(`/${page}/photos`, { ...po, method: 'POST', body: { url: media[0], caption: i.message ?? undefined } });
    return { id: r.post_id ?? r.id };
  }
  const ids: string[] = [];
  for (const url of media) {
    const r = await graph<{ id: string }>(`/${page}/photos`, { ...po, method: 'POST', body: { url, published: false } });
    ids.push(r.id);
  }
  const r = await graph<{ id: string }>(`/${page}/feed`, { ...po, method: 'POST', body: { message: i.message ?? undefined, attached_media: ids.map((id) => ({ media_fbid: id })) } });
  return { id: r.id };
}

/** Post status verification: reads the post back from Meta. */
export async function verifyFacebookPost(c: MetaCtx, postId: string) {
  const r = await graph<{ id: string; created_time?: string; permalink_url?: string }>(`/${postId}`, { ...o(c), token: await pageToken(c), query: { fields: 'id,created_time,permalink_url' } });
  return { id: r.id, createdTime: r.created_time ?? null, permalink: r.permalink_url ?? null };
}

// ---- ads -----------------------------------------------------------------------------------------------------------
/** Uploads an approved image. Only fal.ai-hosted https images are fetched; the bytes go to Meta as base64. */
export async function uploadAdImage(c: MetaCtx, imageUrl: string): Promise<{ hash: string }> {
  if (!validateFalImageOrigin(imageUrl)) throw new MetaApiError('Only images generated by fal.ai can be uploaded as an ad image.', 'invalid', 400);
  const res = await (c.fetchImpl ?? fetch)(imageUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new MetaApiError('Could not download the generated image.', 'transient', res.status);
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\/(png|jpe?g|webp|gif)/.test(type)) throw new MetaApiError('The generated file is not a supported image.', 'invalid', 400);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > 30 * 1024 * 1024) throw new MetaApiError('The image is larger than Meta allows (30 MB).', 'invalid', 400);
  const r = await graph<{ images?: Record<string, { hash: string }> }>(`/${needAd(c)}/adimages`, { ...o(c), method: 'POST', body: { bytes: bytes.toString('base64') } });
  const hash = Object.values(r.images ?? {})[0]?.hash;
  if (!hash) throw new MetaApiError('Meta did not return an image hash.', 'unknown', 502);
  return { hash };
}

export const createAdCampaign = async (c: MetaCtx, i: { name: string; objective: Objective }) =>
  (await graph<{ id: string }>(`/${needAd(c)}/campaigns`, {
    ...o(c), method: 'POST',
    body: { name: i.name, objective: OBJECTIVE_API[i.objective], status: 'PAUSED', special_ad_categories: [] },
  })).id;

export type AdSetInput = {
  campaignId: string; name: string; objective: Objective; budgetType: 'daily' | 'lifetime'; budgetMinor: number;
  startsAt?: string | null; endsAt?: string | null; countries: string[]; ageMin?: number; ageMax?: number;
  placements?: string[]; optimizationGoal?: string | null; bidStrategy?: string | null;
};
export const createAdSet = async (c: MetaCtx, i: AdSetInput) => {
  const targeting: Record<string, unknown> = { geo_locations: { countries: i.countries } };
  if (i.ageMin) targeting.age_min = i.ageMin;
  if (i.ageMax) targeting.age_max = i.ageMax;
  if (i.placements?.length) { targeting.publisher_platforms = ['facebook']; targeting.facebook_positions = i.placements; }
  return (await graph<{ id: string }>(`/${needAd(c)}/adsets`, {
    ...o(c), method: 'POST',
    body: {
      name: i.name, campaign_id: i.campaignId, status: 'PAUSED', billing_event: 'IMPRESSIONS',
      optimization_goal: i.optimizationGoal ?? GOALS[i.objective][0],
      bid_strategy: i.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP',
      [i.budgetType === 'daily' ? 'daily_budget' : 'lifetime_budget']: i.budgetMinor,
      start_time: i.startsAt ?? undefined, end_time: i.endsAt ?? undefined, targeting,
      ...(i.objective === 'leads' ? { destination_type: 'ON_AD', promoted_object: { page_id: needPage(c) } } : {}),
    },
  })).id;
};

export const createAdCreative = async (c: MetaCtx, i: { name: string; imageHash: string; headline?: string | null; primaryText?: string | null; description?: string | null; cta?: string | null; linkUrl?: string | null; leadFormId?: string | null }) => {
  const value = i.leadFormId ? { lead_gen_form_id: i.leadFormId } : { link: i.linkUrl };
  return (await graph<{ id: string }>(`/${needAd(c)}/adcreatives`, {
    ...o(c), method: 'POST',
    body: {
      name: i.name,
      object_story_spec: {
        page_id: needPage(c),
        link_data: {
          image_hash: i.imageHash, link: i.linkUrl ?? `https://www.facebook.com/${needPage(c)}`, message: i.primaryText ?? undefined,
          name: i.headline ?? undefined, description: i.description ?? undefined,
          call_to_action: { type: i.cta ?? 'LEARN_MORE', value },
        },
      },
    },
  })).id;
};

export const createFacebookAd = async (c: MetaCtx, i: { name: string; adSetId: string; creativeId: string }) =>
  (await graph<{ id: string }>(`/${needAd(c)}/ads`, {
    ...o(c), method: 'POST', body: { name: i.name, adset_id: i.adSetId, creative: { creative_id: i.creativeId }, status: 'PAUSED' },
  })).id;

/** The only function that can turn spend on. Callers: the approval path. */
export async function updateAdStatus(c: MetaCtx, objectId: string, status: 'ACTIVE' | 'PAUSED') {
  await graph(`/${objectId}`, { ...o(c), method: 'POST', body: { status } });
}

export async function getAdStatus(c: MetaCtx, adId: string) {
  return graph<{ id: string; name?: string; status?: string; effective_status?: string; issues_info?: unknown[] }>(`/${adId}`, { ...o(c), query: { fields: 'id,name,status,effective_status,issues_info' } });
}

// ---- insights ------------------------------------------------------------------------------------------------------
export type InsightRow = {
  id: string; name: string; spend: number; impressions: number; reach: number; clicks: number; cpc: number | null; cpm: number | null;
  ctr: number | null; leads: number; costPerLead: number | null;
};
type RawInsight = { campaign_id?: string; campaign_name?: string; ad_id?: string; ad_name?: string; spend?: string; impressions?: string; reach?: string; clicks?: string; cpc?: string; cpm?: string; ctr?: string; actions?: { action_type: string; value: string }[] };

const num = (v?: string) => (v === undefined ? 0 : Number(v) || 0);
export function mapInsight(r: RawInsight, level: 'campaign' | 'ad'): InsightRow {
  const spend = num(r.spend);
  // Meta reports leads as the `lead` action (all attribution) — we use that one number and say so in the tool output.
  const leads = num(r.actions?.find((a) => a.action_type === 'lead')?.value);
  return {
    id: (level === 'campaign' ? r.campaign_id : r.ad_id) ?? '', name: (level === 'campaign' ? r.campaign_name : r.ad_name) ?? '',
    spend, impressions: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks),
    cpc: r.cpc === undefined ? null : num(r.cpc), cpm: r.cpm === undefined ? null : num(r.cpm), ctr: r.ctr === undefined ? null : num(r.ctr),
    leads, costPerLead: leads > 0 ? Math.round((spend / leads) * 100) / 100 : null,
  };
}

async function insights(c: MetaCtx, level: 'campaign' | 'ad', range: { datePreset?: string; since?: string; until?: string }) {
  const query: Record<string, string> = {
    level, fields: `${level}_id,${level}_name,spend,impressions,reach,clicks,cpc,cpm,ctr,actions`,
  };
  if (range.since && range.until) query.time_range = JSON.stringify({ since: range.since, until: range.until });
  else query.date_preset = range.datePreset ?? 'last_7d';
  const rows = await graphAll<RawInsight>(`/${needAd(c)}/insights`, { ...o(c), query }, 500);
  return rows.map((r) => mapInsight(r, level));
}
export const getCampaignInsights = (c: MetaCtx, r: { datePreset?: string; since?: string; until?: string } = {}) => insights(c, 'campaign', r);
export const getAdInsights = (c: MetaCtx, r: { datePreset?: string; since?: string; until?: string } = {}) => insights(c, 'ad', r);

// ---- lead forms & leads --------------------------------------------------------------------------------------------
export async function getLeadForms(c: MetaCtx) {
  const page = needPage(c);
  return graphAll<{ id: string; name: string; status?: string }>(`/${page}/leadgen_forms`, { ...o(c), token: await pageToken(c), query: { fields: 'id,name,status' } });
}

export type RawLead = { id: string; created_time?: string; form_id?: string; ad_id?: string; campaign_id?: string; field_data?: { name: string; values: string[] }[] };
export async function getLead(c: MetaCtx, leadId: string): Promise<RawLead> {
  if (!/^\d{5,30}$/.test(leadId)) throw new MetaApiError('Invalid lead id.', 'invalid', 400);
  return graph<RawLead>(`/${leadId}`, { ...o(c), token: await pageToken(c), query: { fields: 'id,created_time,form_id,ad_id,campaign_id,field_data' } });
}

/** Leads submitted to one form: the backfill when a webhook was missed. */
export async function listFormLeads(c: MetaCtx, formId: string, max = 100): Promise<RawLead[]> {
  if (!/^\d{5,30}$/.test(formId)) throw new MetaApiError('Invalid form id.', 'invalid', 400);
  return graphAll<RawLead>(`/${formId}/leads`, { ...o(c), token: await pageToken(c), query: { fields: 'id,created_time,form_id,ad_id,campaign_id,field_data' } }, max);
}

/** Used before retrying a publish whose first attempt may have succeeded unseen: is the same text already on the Page? */
export async function findRecentPost(c: MetaCtx, message: string | null | undefined, sinceIso: string): Promise<string | null> {
  if (!message?.trim()) return null;
  const rows = await graph<{ data: { id: string; message?: string; created_time?: string }[] }>(`/${needPage(c)}/posts`, { ...o(c), token: await pageToken(c), query: { fields: 'id,message,created_time', limit: 10 } });
  const since = Date.parse(sinceIso) - 60_000;
  return rows.data.find((p) => p.message === message && Date.parse(p.created_time ?? '') >= since)?.id ?? null;
}
