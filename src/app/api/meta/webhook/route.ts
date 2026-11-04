import { timingSafeEqual } from 'node:crypto';
import { serviceClient } from '@/lib/supabase/service';
import { getLead } from '@/lib/meta/api';
import { ingestLead, parseLeadgenPayload, verifyWebhookSignature } from '@/lib/meta/leads';
import { metaContext, metaFailure } from '@/lib/meta/marketing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Meta's subscription handshake: echo the challenge only for our verify token. */
export function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN?.trim();
  if (expected && q.get('hub.mode') === 'subscribe' && same(q.get('hub.verify_token') ?? '', expected)) {
    return new Response(q.get('hub.challenge') ?? '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

/**
 * Lead Ads delivery. The signature is checked over the raw body before anything is parsed; an unsigned or wrongly
 * signed request does nothing. The lead itself is fetched from Meta with the owning workspace's credential (the
 * webhook carries only ids), then stored once in Kasturi.
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 1_000_000 || !verifyWebhookSignature(raw, request.headers.get('x-hub-signature-256'), process.env.META_APP_SECRET?.trim())) {
    return new Response('Invalid signature', { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response('Bad request', { status: 400 }); }

  const service = serviceClient();
  let retry = false;
  for (const l of parseLeadgenPayload(body)) {
    const { data: orgId } = await service.rpc('meta_org_for_page', { p_page_id: l.pageId });
    if (!orgId) continue; // not a Page any workspace here has connected
    const m = await metaContext(service, orgId as string);
    if (!m.ok) continue; // blocked: the connection card shows why; no fake lead is created
    try {
      const lead = await getLead(m.ctx, l.leadgenId);
      const r = await ingestLead(service, orgId as string, lead, { campaignId: lead.campaign_id });
      if (r.status === 'error') retry = true;
    } catch (e) {
      await metaFailure(service, orgId as string, e);
      retry = true;
    }
  }
  return new Response(retry ? 'Retry' : 'OK', { status: retry ? 500 : 200 });
}
