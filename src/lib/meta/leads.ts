/**
 * Meta Lead Ads → Kasturi. Server-only, service-role, always for an org id taken from a verified source (the Page the
 * lead belongs to, or a signed-in owner's request).
 *
 * Only the fields Kasturi has a place for are kept (name, email, phone, company): other form answers are not copied,
 * and nothing is stored beside the CRM contact except the Meta lead id, so there is one copy to delete or retain.
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RawLead } from './api';

/** Verifies `X-Hub-Signature-256: sha256=<hex>` over the raw body with the app secret, in constant time. */
export function verifyWebhookSignature(rawBody: string, header: string | null, appSecret: string | undefined): boolean {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

export type WebhookLead = { leadgenId: string; pageId: string; formId: string | null; adId: string | null };

/** Pulls leadgen changes out of a verified webhook payload; anything else is ignored. */
export function parseLeadgenPayload(body: unknown): WebhookLead[] {
  const out: WebhookLead[] = [];
  const b = body as { object?: string; entry?: { changes?: { field?: string; value?: Record<string, unknown> }[] }[] };
  if (b?.object !== 'page') return out;
  for (const entry of b.entry ?? []) {
    for (const ch of entry.changes ?? []) {
      if (ch.field !== 'leadgen') continue;
      const v = ch.value ?? {};
      const leadgenId = String(v.leadgen_id ?? '');
      const pageId = String(v.page_id ?? '');
      if (/^\d{5,30}$/.test(leadgenId) && /^\d{4,30}$/.test(pageId)) {
        out.push({ leadgenId, pageId, formId: v.form_id ? String(v.form_id) : null, adId: v.ad_id ? String(v.ad_id) : null });
      }
    }
  }
  return out;
}

export type MappedLead = { firstName: string; lastName: string | null; email: string | null; phone: string | null; company: string | null };

export function mapLeadFields(fields: { name: string; values: string[] }[] | undefined): MappedLead {
  const get = (...names: string[]) => fields?.find((f) => names.includes(f.name.toLowerCase()))?.values?.[0]?.trim() || null;
  const full = get('full_name', 'name');
  const first = get('first_name');
  const last = get('last_name');
  let firstName = first ?? (full ? full.split(/\s+/)[0] : null);
  let lastName = last ?? (full && full.includes(' ') ? full.split(/\s+/).slice(1).join(' ') : null);
  const email = get('email')?.toLowerCase() ?? null;
  if (!firstName) firstName = email ? email.split('@')[0] : 'Facebook lead';
  if (lastName === '') lastName = null;
  return { firstName: firstName.slice(0, 100), lastName: lastName?.slice(0, 100) ?? null, email: email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null, phone: get('phone_number', 'phone')?.slice(0, 40) ?? null, company: get('company_name', 'company')?.slice(0, 120) ?? null };
}

export type IngestResult = { status: 'created' | 'linked_existing' | 'duplicate' | 'error'; contactId?: string };

/**
 * Stores one lead in Kasturi: contact (reused when the email already exists), a deal in the default pipeline's first
 * stage, and a follow-up task. Idempotent on the Meta lead id: a repeated delivery changes nothing.
 */
export async function ingestLead(service: SupabaseClient, orgId: string, lead: RawLead, attribution: { campaignId?: string | null } = {}): Promise<IngestResult> {
  // Claim the lead id first. The primary key makes concurrent deliveries race safely: the loser sees a conflict.
  const claim = await service.from('meta_lead_ingest').insert({ org_id: orgId, leadgen_id: lead.id, form_id: lead.form_id ?? null, ad_id: lead.ad_id ?? null, campaign_id: attribution.campaignId ?? lead.campaign_id ?? null });
  if (claim.error) return claim.error.code === '23505' ? { status: 'duplicate' } : { status: 'error' };

  try {
    const m = mapLeadFields(lead.field_data);
    let contactId: string | null = null;
    let reused = false;
    if (m.email) {
      const { data } = await service.from('crm_contacts').select('id').eq('org_id', orgId).ilike('email', m.email).limit(1).maybeSingle();
      if (data) { contactId = (data as { id: string }).id; reused = true; }
    }
    if (!contactId) {
      const { data, error } = await service.from('crm_contacts').insert({
        org_id: orgId, first_name: m.firstName, last_name: m.lastName, email: m.email, phone: m.phone, company: m.company,
        source: 'Facebook Lead Ad', status: 'lead', tags: ['lead-form', 'meta-lead-ad', 'consent:meta-lead-form'],
        last_interaction_at: lead.created_time ?? new Date().toISOString(),
      }).select('id').single();
      if (error || !data) throw new Error('contact');
      contactId = (data as { id: string }).id;
    }

    // Pipeline mapping: the default pipeline's first stage. No pipeline set up means no deal, not a failed lead.
    const { data: pipe } = await service.from('crm_pipelines').select('id').eq('org_id', orgId).order('is_default', { ascending: false }).order('created_at').limit(1).maybeSingle();
    if (pipe) {
      const { data: stage } = await service.from('crm_pipeline_stages').select('id').eq('pipeline_id', (pipe as { id: string }).id).order('position').limit(1).maybeSingle();
      if (stage) {
        await service.from('crm_deals').insert({
          org_id: orgId, contact_id: contactId, pipeline_id: (pipe as { id: string }).id, stage_id: (stage as { id: string }).id,
          title: `Facebook lead: ${m.firstName}${m.lastName ? ` ${m.lastName}` : ''}`, tag: 'meta-lead-ad',
        });
      }
    }
    // Campaign attribution + follow-up in one activity the team will see on the contact.
    const cid = attribution.campaignId ?? lead.campaign_id;
    await service.from('crm_activities').insert({
      org_id: orgId, contact_id: contactId, type: 'task', title: 'Follow up new Facebook lead',
      body: `Submitted a Meta Lead Ad${cid ? ` (campaign ${cid})` : ''}${lead.form_id ? `, form ${lead.form_id}` : ''}.`,
      due_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
    });
    await service.from('meta_lead_ingest').update({ contact_id: contactId }).eq('org_id', orgId).eq('leadgen_id', lead.id);
    return { status: reused ? 'linked_existing' : 'created', contactId };
  } catch {
    // Release the claim so Meta's retry (or a manual sync) can try again instead of losing the lead.
    await service.from('meta_lead_ingest').delete().eq('org_id', orgId).eq('leadgen_id', lead.id).is('contact_id', null);
    return { status: 'error' };
  }
}
