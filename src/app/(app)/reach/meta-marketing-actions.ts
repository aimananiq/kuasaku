'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can, type Capability } from '@/lib/auth/permissions';
import * as mk from '@/lib/meta/marketing';
import { zonedToUtc } from '@/lib/meta/validate';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function guard(capability: Capability) {
  const supabase = await createClient();
  const org = await getCurrentOrg(supabase);
  const { data: { user } } = await supabase.auth.getUser();
  if (!org || !user) return { ok: false as const, error: 'Sign in to continue.' };
  if (!can(org.role, capability)) return { ok: false as const, error: 'You do not have permission to do that.' };
  return { ok: true as const, orgId: org.orgId, userId: user.id, service: serviceClient() };
}
const done = (r: mk.Result): ActionResult => { revalidatePath('/reach/ad-settings'); return r.ok ? { ok: true } : { ok: false, error: r.error }; };
const uuid = (v: string) => /^[0-9a-f-]{36}$/i.test(v);

export async function imageDecisionAction(draftId: string, decision: 'approved' | 'rejected'): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  if (!uuid(draftId)) return { ok: false, error: 'Invalid draft.' };
  return done(await mk.setImageDecision(g.service, g.orgId, g.userId, draftId, decision));
}

/** Approval of paid spend: only a person holding `approve-ad-spend`, for the exact settings they were shown. */
export async function approveAdAction(draftId: string, shownHash: string): Promise<ActionResult> {
  const g = await guard('approve-ad-spend'); if (!g.ok) return g;
  if (!uuid(draftId)) return { ok: false, error: 'Invalid draft.' };
  const r = await mk.approveDraft(g.service, g.orgId, g.userId, draftId, shownHash);
  revalidatePath('/reach/ad-settings');
  return r.ok ? { ok: true, message: 'Approved for 24 hours. Activate now or schedule the start.' } : { ok: false, error: r.error };
}

export async function activateAdAction(draftId: string): Promise<ActionResult> {
  const g = await guard('approve-ad-spend'); if (!g.ok) return g;
  if (!uuid(draftId)) return { ok: false, error: 'Invalid draft.' };
  const r = await mk.activateDraft(g.service, g.orgId, draftId, { via: 'user', userId: g.userId });
  revalidatePath('/reach/ad-settings');
  return r.ok ? { ok: true, message: 'The ad is now active on Meta and will spend your budget.' } : { ok: false, error: r.error };
}

export async function scheduleActivationAction(draftId: string, localTime: string, timezone: string): Promise<ActionResult> {
  const g = await guard('approve-ad-spend'); if (!g.ok) return g;
  const at = zonedToUtc(localTime, timezone);
  if (!uuid(draftId) || !at || at.getTime() < Date.now()) return { ok: false, error: 'Choose a valid time in the future.' };
  const r = await mk.scheduleActivation(g.service, g.orgId, g.userId, draftId, at, timezone);
  revalidatePath('/reach/ad-settings');
  return r.ok ? { ok: true, message: 'Activation scheduled. It runs only if the approval is still valid then.' } : { ok: false, error: r.error };
}

export async function pauseAdAction(draftId: string): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  return uuid(draftId) ? done(await mk.pauseDraft(g.service, g.orgId, draftId, g.userId)) : { ok: false, error: 'Invalid draft.' };
}

export async function cancelJobAction(jobId: string): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  return uuid(jobId) ? done(await mk.cancelJob(g.service, g.orgId, g.userId, jobId)) : { ok: false, error: 'Invalid job.' };
}

/** Publishes a saved draft to the Page now. Public: the button asks twice before it calls this. */
export async function publishPostAction(postId: string): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  if (!uuid(postId)) return { ok: false, error: 'Invalid post.' };
  const r = await mk.publishPost(g.service, g.orgId, postId, g.userId);
  revalidatePath('/reach/ad-settings');
  return r.ok ? { ok: true, message: 'Published to your Facebook Page.' } : { ok: false, error: r.error };
}

export async function schedulePostAction(postId: string, localTime: string, timezone: string): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  const at = zonedToUtc(localTime, timezone);
  if (!uuid(postId) || !at) return { ok: false, error: 'Choose a valid time.' };
  const r = await mk.schedulePost(g.service, g.orgId, g.userId, postId, at, timezone);
  revalidatePath('/reach/ad-settings');
  return r.ok ? { ok: true, message: 'Scheduled.' } : { ok: false, error: r.error };
}

export async function cancelPostAction(postId: string): Promise<ActionResult> {
  const g = await guard('manage-ads-account'); if (!g.ok) return g;
  return uuid(postId) ? done(await mk.cancelPost(g.service, g.orgId, g.userId, postId)) : { ok: false, error: 'Invalid post.' };
}
