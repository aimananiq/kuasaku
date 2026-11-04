/**
 * The one Meta action the Weekly Studio agent may propose: save a Facebook Page post as a DRAFT.
 * Approving the proposal only saves the draft. Publishing is a separate, explicit step on the Ad Settings screen, so
 * an agent suggestion can never put anything on the Page by itself.
 */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CapResult } from '@/lib/reach/capabilities';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';

export const createFacebookPostDraftInput = z.object({ message: z.string().trim().min(10).max(1500) });
export type CreateFacebookPostDraftInput = z.infer<typeof createFacebookPostDraftInput>;

export async function createFacebookPostDraft(
  ctx: { client: SupabaseClient; orgId: string },
  input: CreateFacebookPostDraftInput,
): Promise<CapResult<{ postId: string }>> {
  // Same rule as the Meta tools: only an owner or admin of this workspace manages its Page.
  const org = await getCurrentOrg(ctx.client);
  if (!org || org.orgId !== ctx.orgId || !can(org.role, 'manage-ads-account')) {
    return { ok: false, error: 'Only an owner or admin can save Facebook post drafts.' };
  }
  // Loaded here, not at the top: these modules are server-only and write with the service role.
  const [{ createPostRecord }, { serviceClient }] = await Promise.all([import('@/lib/meta/marketing'), import('@/lib/supabase/service')]);
  const { data: auth } = await ctx.client.auth.getUser();
  const r = await createPostRecord(serviceClient(), ctx.orgId, auth.user?.id ?? '', { message: input.message });
  return r.ok ? { ok: true, data: { postId: r.post.id } } : { ok: false, error: r.error };
}
