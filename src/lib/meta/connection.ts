/**
 * Storage for a workspace's Meta connection. Server-only.
 *
 * The token is sealed for the workspace under its own purpose before it is
 * stored, and opened only here, with the service-role client, for a workspace id
 * taken from the verified session or a job row. Nothing here logs a token, and
 * `publicStatus` is the only shape that ever leaves the server.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptApiKey, encryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';

export type MetaStatus = 'connected' | 'permission_required' | 'token_expired' | 'error' | 'disconnected';
export type MetaMethod = 'oauth' | 'system_user';

/** Everything a member may see. No token, no ciphertext. */
export type MetaPublicStatus = {
  connected: boolean;
  method: MetaMethod | null;
  status: MetaStatus | 'not_connected';
  businessName: string | null;
  adAccountId: string | null;
  adAccountName: string | null;
  pageId: string | null;
  pageName: string | null;
  permissions: string[];
  tokenExpiresAt: string | null;
  lastValidatedAt: string | null;
  lastError: string | null;
};

export const NOT_CONNECTED: MetaPublicStatus = {
  connected: false, method: null, status: 'not_connected', businessName: null, adAccountId: null, adAccountName: null,
  pageId: null, pageName: null, permissions: [], tokenExpiresAt: null, lastValidatedAt: null, lastError: null,
};

/** Minimum scopes for connect + publish + ads + insights. leads_retrieval is requested only when Kasturi lead sync is enabled. */
export function oauthScopes(env: Record<string, string | undefined> = process.env): string[] {
  const custom = env.META_OAUTH_SCOPES?.split(',').map((s) => s.trim()).filter((s) => /^[a-z_]+$/.test(s));
  return custom?.length
    ? custom
    : ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
}

export const sealMetaToken = (token: string, orgId: string) => encryptApiKey(token, orgId, process.env, 'org-meta-token');

export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

/** A single-use CSRF state bound to the user and workspace that began the flow. */
export async function createOAuthState(service: SupabaseClient, orgId: string, userId: string): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const { error } = await service.from('meta_oauth_states').insert({ state_hash: hashState(state), org_id: orgId, user_id: userId });
  if (error) throw new Error('Could not start the Meta connection.');
  return state;
}

/** Consumes the state: valid once, unexpired, and only for the same user. Returns the workspace or null. */
export async function consumeOAuthState(service: SupabaseClient, state: string, userId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(state)) return null;
  const { data } = await service
    .from('meta_oauth_states').delete().eq('state_hash', hashState(state)).eq('user_id', userId)
    .gt('expires_at', new Date().toISOString()).select('org_id').maybeSingle();
  return (data as { org_id?: string } | null)?.org_id ?? null;
}

export type SaveInput = {
  orgId: string; actorId: string; method: MetaMethod; token: string; tokenType?: string; expiresAt?: Date | null;
  appId?: string; permissions: string[]; apiVersion?: string;
  businessId?: string | null; businessName?: string | null; adAccountId?: string | null; adAccountName?: string | null;
  pageId?: string | null; pageName?: string | null;
};

export async function audit(service: SupabaseClient, orgId: string, actorId: string, action: string, target?: string) {
  await service.from('activity_log').insert({ org_id: orgId, actor_id: actorId, actor_name: 'Meta connection', action, target: target ?? null, category: 'security' });
}

export async function saveConnection(service: SupabaseClient, i: SaveInput): Promise<void> {
  if (!hasKeySecret()) throw new Error('AI_KEYS_ENCRYPTION_SECRET is not set; the server cannot store credentials.');
  const { error } = await service.from('org_meta_connections').upsert({
    org_id: i.orgId, method: i.method, status: 'connected', ciphertext: sealMetaToken(i.token, i.orgId),
    token_type: i.tokenType ?? 'bearer', token_expires_at: i.expiresAt?.toISOString() ?? null,
    api_version: i.apiVersion ?? undefined, app_id: i.appId ?? null, granted_permissions: i.permissions,
    business_id: i.businessId ?? null, business_name: i.businessName ?? null,
    ad_account_id: i.adAccountId ?? null, ad_account_name: i.adAccountName ?? null,
    page_id: i.pageId ?? null, page_name: i.pageName ?? null,
    last_validated_at: new Date().toISOString(), last_error_code: null, last_error_message: null,
    connected_by: i.actorId, updated_at: new Date().toISOString(),
  });
  if (error) throw new Error('Could not save the Meta connection.');
  await audit(service, i.orgId, i.actorId, `Connected Meta (${i.method})`, i.adAccountId ?? undefined);
}

export type OpenConnection =
  | { state: 'none' }
  | { state: 'unusable' }
  | { state: 'ok'; token: string; method: MetaMethod; status: MetaStatus; adAccountId: string | null; pageId: string | null; apiVersion: string; expiresAt: string | null };

/** `orgId` MUST come from server-side state. */
export async function openConnection(service: SupabaseClient, orgId: string): Promise<OpenConnection> {
  const { data, error } = await service.from('org_meta_connections').select('*').eq('org_id', orgId).maybeSingle();
  if (error) return { state: 'unusable' };
  if (!data) return { state: 'none' };
  const token = hasKeySecret() ? decryptApiKey(data.ciphertext, orgId, process.env, 'org-meta-token') : null;
  if (!token) return { state: 'unusable' };
  return { state: 'ok', token, method: data.method, status: data.status, adAccountId: data.ad_account_id, pageId: data.page_id, apiVersion: data.api_version, expiresAt: data.token_expires_at };
}

export async function markStatus(service: SupabaseClient, orgId: string, status: MetaStatus, code?: string, message?: string) {
  await service.from('org_meta_connections').update({
    status, last_error_code: code ?? null, last_error_message: message?.slice(0, 300) ?? null,
    ...(status === 'connected' ? { last_validated_at: new Date().toISOString() } : {}), updated_at: new Date().toISOString(),
  }).eq('org_id', orgId);
}

export async function selectAssets(service: SupabaseClient, orgId: string, actorId: string, a: { adAccountId?: string; adAccountName?: string; pageId?: string; pageName?: string; businessId?: string; businessName?: string }) {
  const patch: Record<string, string> = {};
  if (a.adAccountId) { patch.ad_account_id = a.adAccountId; patch.ad_account_name = a.adAccountName ?? ''; }
  if (a.pageId) { patch.page_id = a.pageId; patch.page_name = a.pageName ?? ''; }
  if (a.businessId) { patch.business_id = a.businessId; patch.business_name = a.businessName ?? ''; }
  const { error } = await service.from('org_meta_connections').update({ ...patch, updated_at: new Date().toISOString() }).eq('org_id', orgId);
  if (error) throw new Error('Could not save the selection.');
  await audit(service, orgId, actorId, 'Changed Meta assets', a.adAccountId ?? a.pageId ?? a.businessId);
}

export async function deleteConnection(service: SupabaseClient, orgId: string, actorId: string) {
  await service.from('org_meta_connections').delete().eq('org_id', orgId);
  await audit(service, orgId, actorId, 'Disconnected Meta');
}

export async function publicStatus(session: SupabaseClient): Promise<MetaPublicStatus> {
  const { data, error } = await session.rpc('meta_connection_status');
  if (error) return NOT_CONNECTED;
  const r = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!r) return NOT_CONNECTED;
  const exp = (r.token_expires_at as string | null) ?? null;
  const expired = exp !== null && new Date(exp).getTime() < Date.now();
  return {
    connected: r.status === 'connected' && !expired,
    method: r.method as MetaMethod,
    status: expired ? 'token_expired' : (r.status as MetaStatus),
    businessName: (r.business_name as string) || null, adAccountId: (r.ad_account_id as string) || null,
    adAccountName: (r.ad_account_name as string) || null, pageId: (r.page_id as string) || null,
    pageName: (r.page_name as string) || null, permissions: (r.granted_permissions as string[]) ?? [],
    tokenExpiresAt: exp, lastValidatedAt: (r.last_validated_at as string) ?? null,
    lastError: (r.last_error_message as string) ?? null,
  };
}
