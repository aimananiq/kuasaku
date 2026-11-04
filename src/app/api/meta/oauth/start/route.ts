import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getCurrentOrg } from '@/lib/auth/current-org';
import { can } from '@/lib/auth/permissions';
import { createOAuthState, oauthScopes } from '@/lib/meta/connection';
import { graphVersion } from '@/lib/meta/graph';

export const dynamic = 'force-dynamic';

export function redirectUri(request: Request): string {
  return process.env.META_REDIRECT_URI?.trim() || `${new URL(request.url).origin}/api/meta/oauth/callback`;
}

const back = (request: Request, flag: string) =>
  NextResponse.redirect(new URL(`/reach/ad-settings?meta=${flag}`, request.url));

export async function GET(request: Request) {
  const appId = process.env.META_APP_ID?.trim();
  if (!appId || !process.env.META_APP_SECRET?.trim()) return back(request, 'not_configured');

  const supabase = await createClient();
  const org = await getCurrentOrg(supabase);
  if (!org) return NextResponse.redirect(new URL('/login', request.url));
  if (!can(org.role, 'manage-ads-account')) return back(request, 'forbidden');
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));

  const state = await createOAuthState(serviceClient(), org.orgId, user.id);
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri(request));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', oauthScopes().join(','));
  url.searchParams.set('response_type', 'code');
  return NextResponse.redirect(url);
}
