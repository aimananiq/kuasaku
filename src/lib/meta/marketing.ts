/**
 * Meta marketing orchestration: Page posts, paid-ad drafts and their approval, and the job runner.
 * Server-only. Every function takes the workspace id from verified server state, never from model output.
 *
 * Money rules, in one place:
 *  - Meta objects are created PAUSED (api.ts). Only `activateDraft` turns spend on.
 *  - `activateDraft` runs only for a draft a person with `approve-ad-spend` approved, for exactly the settings
 *    that were approved (hash match), before the approval expired, and at most once (atomic status change).
 *  - No AI tool calls `activateDraft`; a scheduled activation job re-checks all of the above when it runs.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openConnection, markStatus, audit } from './connection';
import * as api from './api';
import { MetaApiError } from './graph';
import { backoffMs, configHash, postKind, validateDraft, validatePost, type DraftInput } from './validate';
import { validateFalImageOrigin } from '@/lib/ai/fal-provider';

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string; blocker?: boolean };
const fail = (error: string, blocker = false) => ({ ok: false as const, error, ...(blocker ? { blocker } : {}) });

const APPROVAL_TTL_MS = 24 * 3600_000;

/** Opens the workspace's connection into an API context, or says in plain words why it can't. */
export async function metaContext(service: SupabaseClient, orgId: string): Promise<Result<{ ctx: api.MetaCtx }>> {
  const c = await openConnection(service, orgId);
  if (c.state === 'none') return fail('Meta is not connected. Ask an owner or admin to connect it in Jebat → Ad Settings → Connected account.', true);
  if (c.state === 'unusable') return fail('The stored Meta credential cannot be read. Reconnect Meta in Ad Settings.', true);
  if (c.status !== 'connected') return fail(`The Meta connection needs attention (${c.status.replace('_', ' ')}). Reconnect it in Ad Settings.`, true);
  if (c.expiresAt && Date.parse(c.expiresAt) < Date.now()) {
    await markStatus(service, orgId, 'token_expired', 'expired', 'The Meta access token has expired.');
    return fail('The Meta access token has expired. Reconnect Meta in Ad Settings.', true);
  }
  return { ok: true, ctx: { token: c.token, version: c.apiVersion, adAccountId: c.adAccountId, pageId: c.pageId } };
}

/** Records an auth/permission failure on the connection (so the card shows it) and returns a message safe to show. */
export async function metaFailure(service: SupabaseClient, orgId: string, e: unknown): Promise<string> {
  if (!(e instanceof MetaApiError)) return 'Something went wrong talking to Meta.';
  if (e.kind === 'auth') await markStatus(service, orgId, 'token_expired', String(e.code ?? e.status), e.message);
  else if (e.kind === 'permission') await markStatus(service, orgId, 'permission_required', String(e.code ?? e.status), e.message);
  return e.message;
}

// ================================================================== organic posts
export type PostRow = { id: string; org_id: string; page_id: string; kind: string; message: string | null; link: string | null; media_urls: string[]; status: string; scheduled_at: string | null; fb_post_id: string | null; attempts: number; created_at: string; updated_at: string };

export async function createPostRecord(service: SupabaseClient, orgId: string, userId: string, i: { message?: string | null; link?: string | null; mediaUrls?: string[]; timezone?: string }): Promise<Result<{ post: PostRow }>> {
  const errs = validatePost(i);
  if (errs.length) return fail(errs.join(' '));
  for (const m of i.mediaUrls ?? []) if (!validateFalImageOrigin(m)) return fail('Post images must come from this workspace\'s fal.ai image generation.');
  const conn = await openConnection(service, orgId);
  if (conn.state !== 'ok' || !conn.pageId) return fail('Select a Facebook Page in Ad Settings first.', true);
  const { data, error } = await service.from('meta_page_posts').insert({
    org_id: orgId, page_id: conn.pageId, kind: postKind(i), message: i.message ?? null, link: i.link ?? null, media_urls: i.mediaUrls ?? [],
    timezone: i.timezone ?? 'Asia/Kuala_Lumpur', created_by: userId,
  }).select('*').single();
  if (error || !data) return fail('Could not save the post.');
  await audit(service, orgId, userId, 'Drafted Facebook post', (data as PostRow).id);
  return { ok: true, post: data as PostRow };
}

/**
 * Publishes a draft/scheduled post once. The status change draft|scheduled → publishing is the lock: a second caller
 * (a retried job, a double click) updates zero rows and stops. A post that already has a Facebook id is never re-sent.
 */
export async function publishPost(service: SupabaseClient, orgId: string, postId: string, actorId: string | null): Promise<Result<{ fbPostId: string }>> {
  const { data: existing } = await service.from('meta_page_posts').select('*').eq('org_id', orgId).eq('id', postId).maybeSingle();
  const post = existing as (PostRow & { published_at: string | null }) | null;
  if (!post) return fail('Post not found.');
  if (post.fb_post_id) return { ok: true, fbPostId: post.fb_post_id };
  const wasPublishing = post.status === 'publishing';
  if (['published', 'cancelled'].includes(post.status)) return fail(`This post is ${post.status}.`);

  // A 'publishing' row is only re-claimed when its worker died (the job queue's lock timeout decides that).
  const claimed = await service.from('meta_page_posts').update({ status: 'publishing', attempts: post.attempts + 1, updated_at: new Date().toISOString() })
    .eq('id', postId).eq('org_id', orgId).eq('status', post.status).is('fb_post_id', null).select('id').maybeSingle();
  if (!claimed.data) return fail('This post is already being published.');

  const m = await metaContext(service, orgId);
  if (!m.ok) { await service.from('meta_page_posts').update({ status: 'failed', last_error: m.error }).eq('id', postId); return m; }
  try {
    // A previous attempt may have reached Meta without us hearing back: look before posting again.
    const dup = wasPublishing || post.attempts > 0 ? await api.findRecentPost(m.ctx, post.message, post.updated_at) : null;
    const id = dup ?? (await api.createFacebookPost(m.ctx, { message: post.message, link: post.link, mediaUrls: post.media_urls })).id;
    await service.from('meta_page_posts').update({ status: 'published', fb_post_id: id, published_at: new Date().toISOString(), last_error: null, api_response: { id }, updated_at: new Date().toISOString() }).eq('id', postId);
    await audit(service, orgId, actorId ?? '', 'Published Facebook post', id);
    return { ok: true, fbPostId: id };
  } catch (e) {
    const msg = await metaFailure(service, orgId, e);
    const retryable = e instanceof MetaApiError && e.retryable;
    // 'scheduled' lets the job's next attempt claim it again; 'failed' is final.
    await service.from('meta_page_posts').update({ status: retryable ? 'scheduled' : 'failed', last_error: msg, updated_at: new Date().toISOString() }).eq('id', postId);
    return { ok: false, error: msg };
  }
}

export async function schedulePost(service: SupabaseClient, orgId: string, userId: string, postId: string, runAt: Date, timezone: string): Promise<Result<{ jobId: string }>> {
  const errs = validatePost({ message: 'x', scheduledAt: runAt.toISOString() });
  if (errs.length) return fail(errs.join(' '));
  const { data: post } = await service.from('meta_page_posts').select('id,status').eq('org_id', orgId).eq('id', postId).maybeSingle();
  if (!post || !['draft', 'scheduled'].includes((post as { status: string }).status)) return fail('Only a draft post can be scheduled.');
  await service.from('meta_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('target_id', postId).eq('kind', 'publish_post').in('status', ['pending']);
  const job = await enqueue(service, orgId, userId, 'publish_post', postId, runAt, timezone);
  if (!job.ok) return job;
  await service.from('meta_page_posts').update({ status: 'scheduled', scheduled_at: runAt.toISOString(), timezone, updated_at: new Date().toISOString() }).eq('id', postId);
  await audit(service, orgId, userId, 'Scheduled Facebook post', postId);
  return job;
}

export async function cancelPost(service: SupabaseClient, orgId: string, userId: string, postId: string): Promise<Result> {
  const upd = await service.from('meta_page_posts').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', postId).in('status', ['draft', 'scheduled']).select('id').maybeSingle();
  if (!upd.data) return fail('Only a draft or scheduled post can be cancelled.');
  await service.from('meta_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('target_id', postId).eq('kind', 'publish_post').eq('status', 'pending');
  await audit(service, orgId, userId, 'Cancelled Facebook post', postId);
  return { ok: true };
}

// ================================================================== jobs
export async function enqueue(service: SupabaseClient, orgId: string, userId: string | null, kind: 'publish_post' | 'activate_ad' | 'pause_ad', targetId: string, runAt: Date, timezone: string): Promise<Result<{ jobId: string }>> {
  const key = `${kind}:${targetId}:${runAt.toISOString()}`;
  const { data, error } = await service.from('meta_jobs').insert({ org_id: orgId, kind, target_id: targetId, run_at: runAt.toISOString(), timezone, idempotency_key: key, created_by: userId }).select('id').single();
  if (error) {
    if (error.code === '23505') { const { data: ex } = await service.from('meta_jobs').select('id').eq('idempotency_key', key).maybeSingle(); if (ex) return { ok: true, jobId: (ex as { id: string }).id }; }
    return fail('Could not schedule the job.');
  }
  return { ok: true, jobId: (data as { id: string }).id };
}

type Job = { id: string; org_id: string; kind: string; target_id: string; attempts: number; max_attempts: number; created_by: string | null };

/** Runs due jobs. Safe to call concurrently and after a restart: claiming is atomic and every handler is idempotent. */
export async function runDueJobs(service: SupabaseClient, limit = 10): Promise<{ ran: number; done: number; retried: number; failed: number }> {
  const { data } = await service.rpc('meta_claim_jobs', { p_limit: limit });
  const jobs = (data ?? []) as Job[];
  const tally = { ran: jobs.length, done: 0, retried: 0, failed: 0 };
  for (const j of jobs) {
    let r: Result;
    try {
      r = j.kind === 'publish_post' ? await publishPost(service, j.org_id, j.target_id, j.created_by)
        : j.kind === 'activate_ad' ? await activateDraft(service, j.org_id, j.target_id, { via: 'schedule' })
        : await pauseDraft(service, j.org_id, j.target_id, j.created_by);
    } catch { r = fail('Unexpected error.'); }
    const now = new Date().toISOString();
    if (r.ok) { tally.done++; await service.from('meta_jobs').update({ status: 'done', last_error: null, locked_at: null, updated_at: now }).eq('id', j.id); continue; }
    // A blocker (not connected, not approved, expired approval) will not fix itself by retrying.
    const final = j.attempts >= j.max_attempts || r.blocker === true || /not approved|expired|already/i.test(r.error);
    if (final) { tally.failed++; await service.from('meta_jobs').update({ status: 'failed', last_error: r.error.slice(0, 300), locked_at: null, updated_at: now }).eq('id', j.id); }
    else { tally.retried++; await service.from('meta_jobs').update({ status: 'pending', run_at: new Date(Date.now() + backoffMs(j.attempts)).toISOString(), last_error: r.error.slice(0, 300), locked_at: null, updated_at: now }).eq('id', j.id); }
  }
  return tally;
}

export async function cancelJob(service: SupabaseClient, orgId: string, userId: string, jobId: string): Promise<Result> {
  const upd = await service.from('meta_jobs').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('org_id', orgId).eq('id', jobId).eq('status', 'pending').select('id,kind,target_id').maybeSingle();
  if (!upd.data) return fail('Only a pending job can be cancelled.');
  const j = upd.data as { kind: string; target_id: string };
  if (j.kind === 'publish_post') await service.from('meta_page_posts').update({ status: 'draft', scheduled_at: null }).eq('id', j.target_id).eq('status', 'scheduled');
  await audit(service, orgId, userId, 'Cancelled scheduled job', jobId);
  return { ok: true };
}

// ================================================================== paid ads
export type DraftRow = {
  id: string; org_id: string; name: string; ad_account_id: string; page_id: string; objective: string; budget_type: 'daily' | 'lifetime'; budget_minor: number; currency: string;
  starts_at: string | null; ends_at: string | null; timezone: string; targeting: { countries?: string[]; ageMin?: number; ageMax?: number }; placements: string[];
  optimization_goal: string | null; bid_strategy: string | null; headline: string | null; primary_text: string | null; description: string | null; cta: string | null;
  link_url: string | null; lead_form_id: string | null; image_url: string | null; image_status: string; image_hash: string | null;
  meta_campaign_id: string | null; meta_adset_id: string | null; meta_creative_id: string | null; meta_ad_id: string | null;
  status: string; config_hash: string | null; approved_hash: string | null; approved_by: string | null; approved_at: string | null; approval_expires_at: string | null;
  activated_at: string | null; last_error: string | null; created_at: string;
};

export async function spendPolicy(service: SupabaseClient, orgId: string) {
  const { data } = await service.from('ad_settings').select('daily_cap_cents,monthly_cap_cents,currency').eq('org_id', orgId).maybeSingle();
  const r = data as { daily_cap_cents: number | null; monthly_cap_cents: number | null; currency: string } | null;
  return { maxDailyMinor: r?.daily_cap_cents ?? null, maxLifetimeMinor: r?.monthly_cap_cents ?? null, currency: r?.currency ?? 'MYR' };
}

export const hashOf = (d: DraftRow) => configHash(d as unknown as Record<string, unknown>);

export async function createAdDraft(service: SupabaseClient, orgId: string, userId: string, i: DraftInput & { imageUrl?: string | null; timezone?: string }): Promise<Result<{ draft: DraftRow; warnings: string[] }>> {
  const conn = await openConnection(service, orgId);
  if (conn.state !== 'ok' || !conn.adAccountId || !conn.pageId) return fail('Select an ad account and a Facebook Page in Ad Settings first.', true);
  const policy = await spendPolicy(service, orgId);
  // No cap, no spend: a workspace must state the most it is willing to spend before a draft can exist.
  if (i.budgetType === 'daily' ? policy.maxDailyMinor === null : policy.maxLifetimeMinor === null) {
    return fail(`Set a ${i.budgetType === 'daily' ? 'daily' : 'monthly'} spending cap in Ad Settings before preparing a paid campaign.`, true);
  }
  const errs = validateDraft(i, policy);
  if (i.imageUrl && !validateFalImageOrigin(i.imageUrl)) errs.push('The ad image must be one generated through fal.ai.');
  if (errs.length) return fail(errs.join(' '));
  const row = {
    org_id: orgId, name: i.name.trim(), ad_account_id: conn.adAccountId, page_id: conn.pageId, objective: i.objective, budget_type: i.budgetType, budget_minor: i.budgetMinor,
    currency: i.currency.toUpperCase(), starts_at: i.startsAt ?? null, ends_at: i.endsAt ?? null, timezone: i.timezone ?? 'Asia/Kuala_Lumpur', targeting: i.targeting,
    placements: i.placements ?? [], optimization_goal: i.optimizationGoal ?? null, bid_strategy: i.bidStrategy ?? null, headline: i.headline ?? null,
    primary_text: i.primaryText ?? null, description: i.description ?? null, cta: i.cta ?? null, link_url: i.linkUrl ?? null, lead_form_id: i.leadFormId ?? null,
    image_url: i.imageUrl ?? null, created_by: userId,
  };
  const { data, error } = await service.from('meta_ad_drafts').insert(row).select('*').single();
  if (error || !data) return fail('Could not save the ad draft.');
  const draft = data as DraftRow;
  await service.from('meta_ad_drafts').update({ config_hash: hashOf(draft) }).eq('id', draft.id);
  await audit(service, orgId, userId, 'Prepared ad draft', draft.id);
  return { ok: true, draft, warnings: i.imageUrl ? [] : ['No image yet: generate one and attach it before building the ad on Meta.'] };
}

export async function getDraft(service: SupabaseClient, orgId: string, id: string): Promise<DraftRow | null> {
  const { data } = await service.from('meta_ad_drafts').select('*').eq('org_id', orgId).eq('id', id).maybeSingle();
  return (data as DraftRow | null) ?? null;
}

/** A person approves or rejects the generated image. Paid objects are not built from an unapproved image. */
export async function setImageDecision(service: SupabaseClient, orgId: string, userId: string, id: string, decision: 'approved' | 'rejected'): Promise<Result> {
  const d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.');
  if (d.meta_creative_id) return fail('The creative is already built on Meta. Prepare a new draft to change the image.');
  const patch = decision === 'rejected' ? { image_status: 'rejected', image_url: null } : { image_status: 'approved' };
  await service.from('meta_ad_drafts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId);
  await audit(service, orgId, userId, `Image ${decision} for ad draft`, id);
  return { ok: true };
}

export async function attachImage(service: SupabaseClient, orgId: string, id: string, imageUrl: string): Promise<Result> {
  if (!validateFalImageOrigin(imageUrl)) return fail('The ad image must be one generated through fal.ai.');
  const d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.');
  if (d.meta_creative_id) return fail('The creative is already built on Meta. Prepare a new draft to change the image.');
  const u = await service.from('meta_ad_drafts').update({ image_url: imageUrl, image_status: 'pending', updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId).select('*').single();
  if (u.data) await service.from('meta_ad_drafts').update({ config_hash: hashOf(u.data as DraftRow) }).eq('id', id);
  return { ok: true };
}

/**
 * Builds Campaign → Ad Set → Image → Creative → Ad on Meta, all PAUSED. Each created id is saved at once, so a retry
 * resumes where it stopped instead of creating a second campaign.
 */
export async function buildOnMeta(service: SupabaseClient, orgId: string, userId: string, id: string): Promise<Result<{ draft: DraftRow }>> {
  let d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.');
  if (['active', 'approved', 'approval_requested'].includes(d.status)) return fail('This ad is already built.');
  if (d.image_status !== 'approved' || !d.image_url) return fail('Approve the ad image first (or regenerate it) before building the ad on Meta.', true);
  const policy = await spendPolicy(service, orgId);
  const errs = validateDraft({ name: d.name, objective: d.objective as DraftInput['objective'], budgetType: d.budget_type, budgetMinor: Number(d.budget_minor), currency: d.currency, startsAt: d.starts_at, endsAt: d.ends_at, targeting: { countries: d.targeting.countries ?? [], ageMin: d.targeting.ageMin, ageMax: d.targeting.ageMax }, placements: d.placements, optimizationGoal: d.optimization_goal, bidStrategy: d.bid_strategy, headline: d.headline, primaryText: d.primary_text, description: d.description, cta: d.cta, linkUrl: d.link_url, leadFormId: d.lead_form_id }, policy);
  if (errs.length) return fail(errs.join(' '));
  const m = await metaContext(service, orgId);
  if (!m.ok) return m;
  // The draft was written for one account and Page; build only against the same ones.
  if (m.ctx.adAccountId !== d.ad_account_id || m.ctx.pageId !== d.page_id) return fail('The connected ad account or Page changed since this draft was prepared. Prepare a new draft.', true);

  const save = async (patch: Partial<Record<string, unknown>>) => { await service.from('meta_ad_drafts').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId); d = { ...d!, ...patch } as DraftRow; };
  try {
    if (!d.meta_campaign_id) await save({ meta_campaign_id: await api.createAdCampaign(m.ctx, { name: d.name, objective: d.objective as DraftInput['objective'] }) });
    if (!d.meta_adset_id) await save({ meta_adset_id: await api.createAdSet(m.ctx, { campaignId: d.meta_campaign_id!, name: `${d.name} – ad set`, objective: d.objective as DraftInput['objective'], budgetType: d.budget_type, budgetMinor: Number(d.budget_minor), startsAt: d.starts_at, endsAt: d.ends_at, countries: d.targeting.countries ?? [], ageMin: d.targeting.ageMin, ageMax: d.targeting.ageMax, placements: d.placements, optimizationGoal: d.optimization_goal, bidStrategy: d.bid_strategy }) });
    if (!d.image_hash) await save({ image_hash: (await api.uploadAdImage(m.ctx, d.image_url)).hash });
    if (!d.meta_creative_id) await save({ meta_creative_id: await api.createAdCreative(m.ctx, { name: `${d.name} – creative`, imageHash: d.image_hash!, headline: d.headline, primaryText: d.primary_text, description: d.description, cta: d.cta, linkUrl: d.link_url, leadFormId: d.lead_form_id }) });
    if (!d.meta_ad_id) await save({ meta_ad_id: await api.createFacebookAd(m.ctx, { name: d.name, adSetId: d.meta_adset_id!, creativeId: d.meta_creative_id! }) });
    await save({ status: 'created_paused', last_error: null, config_hash: hashOf(d) });
    await audit(service, orgId, userId, 'Built paused ad on Meta', d.meta_ad_id!);
    return { ok: true, draft: d };
  } catch (e) {
    const msg = await metaFailure(service, orgId, e);
    await save({ last_error: msg });
    return fail(`${msg} (Created so far is saved; run the build again to continue.)`);
  }
}

export async function requestApproval(service: SupabaseClient, orgId: string, userId: string, id: string): Promise<Result<{ draft: DraftRow }>> {
  const d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.');
  if (d.status !== 'created_paused' && d.status !== 'approval_requested') return fail('Build the paused ad on Meta before asking for approval.');
  const hash = hashOf(d);
  await service.from('meta_ad_drafts').update({ status: 'approval_requested', config_hash: hash, approval_requested_by: userId, approval_requested_at: new Date().toISOString(), approved_by: null, approved_hash: null, approved_at: null, approval_expires_at: null, updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId);
  await audit(service, orgId, userId, 'Requested ad approval', id);
  return { ok: true, draft: { ...d, status: 'approval_requested', config_hash: hash } };
}

/** The approver is a signed-in person with `approve-ad-spend`; the caller (a server action) checks that. */
export async function approveDraft(service: SupabaseClient, orgId: string, approverId: string, id: string, expectedHash: string): Promise<Result<{ expiresAt: string }>> {
  const d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.');
  if (d.status !== 'approval_requested') return fail('This ad is not waiting for approval.');
  const hash = hashOf(d);
  // The approver approves what they were shown. If it changed since, they must look again.
  if (hash !== expectedHash || hash !== d.config_hash) return fail('The ad settings changed since you opened this. Review it again.');
  const policy = await spendPolicy(service, orgId);
  const cap = d.budget_type === 'daily' ? policy.maxDailyMinor : policy.maxLifetimeMinor;
  if (cap === null || Number(d.budget_minor) > cap) return fail('This budget is above the workspace spending limit.');
  const expires = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  const u = await service.from('meta_ad_drafts').update({ status: 'approved', approved_by: approverId, approved_hash: hash, approved_at: new Date().toISOString(), approval_expires_at: expires, updated_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', orgId).eq('status', 'approval_requested').select('id').maybeSingle();
  if (!u.data) return fail('This ad is not waiting for approval.');
  await audit(service, orgId, approverId, 'Approved ad spend', id);
  return { ok: true, expiresAt: expires };
}

/** Turns spend on. Callable only after `approveDraft`; re-verifies everything and activates at most once. */
export async function activateDraft(service: SupabaseClient, orgId: string, id: string, by: { via: 'user' | 'schedule'; userId?: string }): Promise<Result> {
  const d = await getDraft(service, orgId, id);
  if (!d) return fail('Draft not found.', true);
  if (d.status === 'active') return fail('This ad is already active.', true);
  if (d.status !== 'approved' || !d.approved_by || !d.approved_hash) return fail('This ad is not approved for activation.', true);
  if (!d.approval_expires_at || Date.parse(d.approval_expires_at) < Date.now()) return fail('The approval has expired. Request approval again.', true);
  if (hashOf(d) !== d.approved_hash) return fail('The ad settings changed after approval. Request approval again.', true);
  const policy = await spendPolicy(service, orgId);
  const cap = d.budget_type === 'daily' ? policy.maxDailyMinor : policy.maxLifetimeMinor;
  if (cap === null || Number(d.budget_minor) > cap) return fail('This budget is above the workspace spending limit.', true);
  if (!d.meta_campaign_id || !d.meta_adset_id || !d.meta_ad_id) return fail('The ad is not fully built on Meta.', true);

  // Atomic: only one caller moves approved → active.
  const lock = await service.from('meta_ad_drafts').update({ status: 'active', activated_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId).eq('status', 'approved').select('id').maybeSingle();
  if (!lock.data) return fail('This ad is already active.', true);

  const m = await metaContext(service, orgId);
  const undo = async (msg: string) => { await service.from('meta_ad_drafts').update({ status: 'approved', activated_at: null, last_error: msg.slice(0, 300) }).eq('id', id); };
  if (!m.ok) { await undo(m.error); return m; }
  try {
    // Campaign, ad set, then ad: Meta delivers only when all three are ACTIVE.
    await api.updateAdStatus(m.ctx, d.meta_campaign_id, 'ACTIVE');
    await api.updateAdStatus(m.ctx, d.meta_adset_id, 'ACTIVE');
    await api.updateAdStatus(m.ctx, d.meta_ad_id, 'ACTIVE');
    await audit(service, orgId, d.approved_by, `Activated ad (${by.via})`, d.meta_ad_id);
    return { ok: true };
  } catch (e) {
    const msg = await metaFailure(service, orgId, e);
    await undo(msg);
    return fail(msg);
  }
}

/** Pausing always allowed: it only stops spend. */
export async function pauseDraft(service: SupabaseClient, orgId: string, id: string, actorId: string | null): Promise<Result> {
  const d = await getDraft(service, orgId, id);
  if (!d?.meta_campaign_id) return fail('Nothing to pause: the ad is not built on Meta.');
  const m = await metaContext(service, orgId);
  if (!m.ok) return m;
  try {
    for (const objectId of [d.meta_ad_id, d.meta_adset_id, d.meta_campaign_id]) if (objectId) await api.updateAdStatus(m.ctx, objectId, 'PAUSED');
    await service.from('meta_ad_drafts').update({ status: 'paused', updated_at: new Date().toISOString() }).eq('id', id).eq('org_id', orgId);
    await audit(service, orgId, actorId ?? '', 'Paused ad', d.meta_ad_id ?? id);
    return { ok: true };
  } catch (e) {
    return fail(await metaFailure(service, orgId, e));
  }
}

/** Schedules an activation. The approval is checked again when the job runs, not just now. */
export async function scheduleActivation(service: SupabaseClient, orgId: string, userId: string, id: string, runAt: Date, timezone: string): Promise<Result<{ jobId: string }>> {
  const d = await getDraft(service, orgId, id);
  if (!d || d.status !== 'approved') return fail('Only an approved ad can be scheduled for activation.');
  if (!d.approval_expires_at || Date.parse(d.approval_expires_at) < runAt.getTime()) return fail('The approval expires before that time. Approve again closer to the start, or choose an earlier time.');
  return enqueue(service, orgId, userId, 'activate_ad', id, runAt, timezone);
}
