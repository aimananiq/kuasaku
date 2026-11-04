import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { consumeOAuthState, saveConnection } from '@/lib/meta/connection';
import { graphVersion, grantedPermissions, listAdAccounts, listBusinesses, listPages, MetaApiError } from '@/lib/meta/graph';
import { redirectUri } from '../start/route';

export const dynamic = 'force-dynamic';

const back = (request: Request, flag: string) =>
  NextResponse.redirect(new URL(`/reach/ad-settings?meta=${flag}`, request.url));

type TokenResponse = { access_token: string; token_type?: string; expires_in?: number };

/** The app secret travels in the POST body to Meta only; it is never put in a URL we log or return. */
async function exchange(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`https://graph.facebook.com/${graphVersion()}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: { message?: string } };
  if (!res.ok || !json.access_token) throw new MetaApiError('Meta did not accept the authorisation code.', 'auth', res.status);
  return json;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('error')) return back(request, 'denied');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return back(request, 'invalid');

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));
  const service = serviceClient();

  const stateOrg = await consumeOAuthState(service, state, user.id);
  const org = await getCurrentOrg(supabase);
  // The workspace that began the flow must still be the caller's, and they must still be allowed to connect.
  if (!stateOrg || !org || org.orgId !== stateOrg || !can(org.role, 'manage-ads-account')) return back(request, 'invalid');

  const appId = process.env.META_APP_ID!.trim();
  const appSecret = process.env.META_APP_SECRET!.trim();
  try {
    const short = await exchange({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri(request), code });
    const long = await exchange({ grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token });
    const opts = { token: long.access_token };
    const [permissions, businesses, adAccounts, pages] = await Promise.all([
      grantedPermissions(opts),
      listBusinesses(opts).catch(() => []), // needs business_management; absent is not fatal
      listAdAccounts(opts).catch(() => []),
      listPages(opts).catch(() => []),
    ]);
    // Preselect only when there is exactly one choice; otherwise the user picks in the card.
    const ad = adAccounts.length === 1 ? adAccounts[0] : null;
    const pg = pages.length === 1 ? pages[0] : null;
    const biz = businesses.length === 1 ? businesses[0] : null;
    await saveConnection(service, {
      orgId: org.orgId, actorId: user.id, method: 'oauth', token: long.access_token, tokenType: long.token_type,
      expiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null,
      appId, permissions, apiVersion: graphVersion(),
      businessId: biz?.id, businessName: biz?.name, adAccountId: ad ? `act_${ad.account_id}` : null, adAccountName: ad?.name,
      pageId: pg?.id, pageName: pg?.name,
    });
    return back(request, 'connected');
  } catch (e) {
    console.error('[meta] connect failed:', e instanceof MetaApiError ? `${e.kind}/${e.code ?? e.status}` : 'error');
    return back(request, 'error');
  }
}
