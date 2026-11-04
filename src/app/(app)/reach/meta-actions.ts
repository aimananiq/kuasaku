'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { deleteConnection, markStatus, openConnection, saveConnection, selectAssets } from '@/lib/meta/connection';
import { graph, graphVersion, grantedPermissions, listAdAccounts, listBusinesses, listPages, MetaApiError } from '@/lib/meta/graph';

export type MetaActionResult = { ok: true; message?: string } | { ok: false; error: string };
export type MetaAssets = {
  businesses: { id: string; name: string }[];
  adAccounts: { id: string; name: string }[];
  pages: { id: string; name: string }[];
};

async function guard() {
  const supabase = await createClient();
  const org = await getCurrentOrg(supabase);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!org || !user) return { ok: false as const, error: 'Sign in to continue.' };
  if (!can(org.role, 'manage-ads-account')) return { ok: false as const, error: 'Only an owner or admin can manage the Meta connection.' };
  return { ok: true as const, org, user, service: serviceClient() };
}

const describe = (e: unknown) => (e instanceof MetaApiError ? e.message : 'Something went wrong talking to Meta.');

/** Re-checks the token and the granted permissions against Meta, and records the outcome. */
export async function testMetaConnectionAction(): Promise<MetaActionResult> {
  const g = await guard();
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await openConnection(g.service, g.org.orgId);
  if (conn.state !== 'ok') return { ok: false, error: 'No usable Meta connection. Connect again.' };
  try {
    const permissions = await grantedPermissions({ token: conn.token, version: conn.apiVersion });
    await g.service.from('org_meta_connections').update({ granted_permissions: permissions }).eq('org_id', g.org.orgId);
    await markStatus(g.service, g.org.orgId, permissions.length ? 'connected' : 'permission_required');
    revalidatePath('/reach/ad-settings');
    return { ok: true, message: 'Connection verified.' };
  } catch (e) {
    const kind = e instanceof MetaApiError ? e.kind : 'unknown';
    await markStatus(g.service, g.org.orgId, kind === 'auth' ? 'token_expired' : kind === 'permission' ? 'permission_required' : 'error', e instanceof MetaApiError ? String(e.code ?? e.status) : undefined, describe(e));
    revalidatePath('/reach/ad-settings');
    return { ok: false, error: describe(e) };
  }
}

/** The assets this token can see, for the pickers. Names and ids only. */
export async function listMetaAssetsAction(): Promise<{ ok: true; assets: MetaAssets } | { ok: false; error: string }> {
  const g = await guard();
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await openConnection(g.service, g.org.orgId);
  if (conn.state !== 'ok') return { ok: false, error: 'No usable Meta connection.' };
  const o = { token: conn.token, version: conn.apiVersion };
  try {
    const [b, a, p] = await Promise.all([listBusinesses(o).catch(() => []), listAdAccounts(o).catch(() => []), listPages(o).catch(() => [])]);
    return { ok: true, assets: { businesses: b, adAccounts: a.map((x) => ({ id: `act_${x.account_id}`, name: x.name })), pages: p } };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}

/** Saves a choice only if it appears in what the token can actually see: scope alone never grants an asset. */
export async function selectMetaAssetAction(kind: 'business' | 'adAccount' | 'page', id: string): Promise<MetaActionResult> {
  const g = await guard();
  if (!g.ok) return { ok: false, error: g.error };
  const listed = await listMetaAssetsAction();
  if (!listed.ok) return listed;
  const pool = kind === 'business' ? listed.assets.businesses : kind === 'adAccount' ? listed.assets.adAccounts : listed.assets.pages;
  const hit = pool.find((x) => x.id === id);
  if (!hit) return { ok: false, error: 'That asset is not accessible with this connection.' };
  await selectAssets(g.service, g.org.orgId, g.user.id,
    kind === 'business' ? { businessId: hit.id, businessName: hit.name }
    : kind === 'adAccount' ? { adAccountId: hit.id, adAccountName: hit.name }
    : { pageId: hit.id, pageName: hit.name });
  revalidatePath('/reach/ad-settings');
  return { ok: true };
}

/** Method B: a system-user token for business-owned assets. Validated against Meta before it is stored. */
export async function saveSystemUserAction(formData: FormData): Promise<MetaActionResult> {
  const g = await guard();
  if (!g.ok) return { ok: false, error: g.error };
  const token = String(formData.get('token') ?? '').trim();
  const appId = String(formData.get('appId') ?? '').trim();
  const businessId = String(formData.get('businessId') ?? '').trim();
  const adAccountRaw = String(formData.get('adAccountId') ?? '').trim();
  const pageId = String(formData.get('pageId') ?? '').trim();
  const adAccountId = adAccountRaw ? (adAccountRaw.startsWith('act_') ? adAccountRaw : `act_${adAccountRaw}`) : '';
  if (!/^[A-Za-z0-9_-]{20,600}$/.test(token)) return { ok: false, error: 'That does not look like an access token.' };
  if (appId && !/^\d{5,25}$/.test(appId)) return { ok: false, error: 'The App ID should be digits only.' };
  if (businessId && !/^\d{4,30}$/.test(businessId)) return { ok: false, error: 'The Business Portfolio ID should be digits only.' };
  if (adAccountId && !/^act_\d{4,30}$/.test(adAccountId)) return { ok: false, error: 'The Ad Account ID should look like act_1234567890.' };
  if (pageId && !/^\d{4,30}$/.test(pageId)) return { ok: false, error: 'The Page ID should be digits only.' };

  const o = { token, version: graphVersion() };
  try {
    const permissions = await grantedPermissions(o).catch(() => [] as string[]);
    // The token must really reach every asset named; token scope alone never guarantees asset access.
    let adName: string | null = null;
    let pageName: string | null = null;
    let bizName: string | null = null;
    if (adAccountId) adName = (await graph<{ name: string }>(`/${adAccountId}`, { ...o, query: { fields: 'name' } })).name;
    if (pageId) pageName = (await graph<{ name: string }>(`/${pageId}`, { ...o, query: { fields: 'name' } })).name;
    if (businessId) bizName = (await graph<{ name: string }>(`/${businessId}`, { ...o, query: { fields: 'name' } })).name;
    await saveConnection(g.service, {
      orgId: g.org.orgId, actorId: g.user.id, method: 'system_user', token, appId: appId || undefined, permissions,
      apiVersion: o.version, businessId: businessId || null, businessName: bizName, adAccountId: adAccountId || null,
      adAccountName: adName, pageId: pageId || null, pageName,
    });
    revalidatePath('/reach/ad-settings');
    return { ok: true, message: 'System user connected.' };
  } catch (e) {
    return { ok: false, error: `Could not verify access: ${describe(e)}` };
  }
}

/** Removes the stored credential. For OAuth connections it also asks Meta to revoke this app's permissions. */
export async function disconnectMetaAction(): Promise<MetaActionResult> {
  const g = await guard();
  if (!g.ok) return { ok: false, error: g.error };
  const conn = await openConnection(g.service, g.org.orgId);
  if (conn.state === 'ok' && conn.method === 'oauth') {
    await graph('/me/permissions', { token: conn.token, version: conn.apiVersion, method: 'DELETE', retries: 0 }).catch(() => undefined);
  }
  await deleteConnection(g.service, g.org.orgId, g.user.id);
  revalidatePath('/reach/ad-settings');
  return { ok: true, message: 'Meta disconnected.' };
}
