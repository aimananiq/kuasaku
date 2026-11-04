import { describe, expect, it, vi } from 'vitest';
import { createSharedTools, type SharedToolContext } from '@/lib/ai/shared-tools';

function createMockSupabase() {
  const store = {
    landingPages: new Map<string, Record<string, unknown>>(),
    forms: new Map<string, Record<string, unknown>>(),
  };

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'crm_landing_pages') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            const id = 'page-uuid-' + Math.random().toString(36).substring(2, 7);
            const saved = { ...row, id, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
            store.landingPages.set(id, saved);
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: saved, error: null }),
              }),
            };
          }),
          update: vi.fn((patch: Record<string, unknown>) => {
            return {
              eq: vi.fn((col: string, val: string) => {
                if (col === 'id') {
                  const existing = store.landingPages.get(val);
                  if (existing) {
                    const updated = { ...existing, ...patch };
                    store.landingPages.set(val, updated);
                  }
                }
                return {
                  eq: vi.fn().mockReturnThis(),
                  select: vi.fn().mockResolvedValue({
                    data: [store.landingPages.get(val)],
                    error: null,
                  }),
                };
              }),
            };
          }),
          select: vi.fn(() => ({
            eq: vi.fn((col: string, val: string) => ({
              eq: vi.fn().mockReturnThis(),
              single: vi.fn().mockResolvedValue({
                data: store.landingPages.get(val) || null,
                error: null,
              }),
            })),
          })),
        };
      }
      if (table === 'forms') {
        return {
          insert: vi.fn((row: Record<string, unknown>) => {
            const id = 'form-uuid-' + Math.random().toString(36).substring(2, 7);
            const saved = { ...row, id };
            store.forms.set(id, saved);
            return {
              select: vi.fn().mockReturnValue({
                single: vi.fn().mockResolvedValue({ data: saved, error: null }),
              }),
            };
          }),
        };
      }
      return {
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
      };
    }),
  };

  return { client: client as unknown as import('@supabase/supabase-js').SupabaseClient, store };
}

describe('Landing Page Generation Engine Suite', () => {
  it('executes full landing page generation workflow: copy, hero visual, form, CRM link and draft save', async () => {
    const { client, store } = createMockSupabase();
    const orgId = 'org-univ-01';

    const ctx: SharedToolContext = {
      agent: 'jebat',
      client,
      orgId,
      canWrite: true,
      falKey: 'mock-fal-key',
    };

    // 1. Mock fal.ai image generation for Hero Visual
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            images: [
              {
                url: 'https://v3.fal.media/files/young-lecturer-hero.webp',
                width: 1920,
                height: 1080,
                content_type: 'image/webp',
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const tools = createSharedTools(ctx);
    const opts = { toolCallId: 'test-call', messages: [], context: {} } as any;

    // Step 1: Generate Hero Image
    const imgRes = (await (tools.generate_image as any).execute(
      {
        prompt:
          'Professional young university lecturers collaborating in a modern lecture hall, premium photography',
        image_size: 'landscape_16_9',
        output_format: 'webp',
      },
      opts,
    )) as { ok: boolean; url: string };

    expect(imgRes.ok).toBe(true);
    expect(imgRes.url).toBe('https://v3.fal.media/files/young-lecturer-hero.webp');

    // Step 2: Create Lead Form in CRM
    const formRes = (await (tools.create_lead_form as any).execute(
      {
        name: 'Young Lecturer Registration Form',
        category: 'Higher Education',
        slug: 'ylp-registration',
        consent_text: 'I consent to receiving information regarding the Young Lecturer Programme.',
      },
      opts,
    )) as { ok: boolean; form_id: string };

    expect(formRes.ok).toBe(true);
    expect(formRes.form_id).toBeDefined();

    // Step 3: Generate Landing Page content
    const pagePlan = (await (tools.generate_landing_page as any).execute(
      {
        name: 'Young Lecturer Programme 2027',
        headline: 'Shape the Future of Higher Education',
        subheadline: 'A fully sponsored leadership path for aspiring Malaysian academicians',
        programme_info: 'Two-year accelerated mentorship with top research institutions.',
        benefits: [
          'Full scholarship',
          'Industry research grant RM 50,000',
          'Tenured faculty placement guarantee',
        ],
        features: ['AI in Pedagogy Module', 'International Exchange to Cambridge & Melbourne'],
        cta_text: 'Apply for Intake 2027',
        hero_image_url: imgRes.url,
        lead_form_id: formRes.form_id,
        status: 'draft',
      },
      opts,
    )) as { ok: boolean; landing_page_draft: { name: string; headline: string; body: string; button_label: string } };

    expect(pagePlan.ok).toBe(true);
    expect(pagePlan.landing_page_draft.body).toContain(imgRes.url);
    expect(pagePlan.landing_page_draft.body).toContain('Tenured faculty placement guarantee');

    // Step 4: Persist draft to database
    const saveRes = (await (tools.save_landing_page as any).execute(
      {
        name: pagePlan.landing_page_draft.name,
        headline: pagePlan.landing_page_draft.headline,
        body: pagePlan.landing_page_draft.body,
        button_label: pagePlan.landing_page_draft.button_label,
        form_id: formRes.form_id,
        status: 'draft',
      },
      opts,
    )) as { ok: boolean; page_id: string; path: string; status: string };

    expect(saveRes.ok).toBe(true);
    expect(saveRes.page_id).toBeDefined();
    expect(saveRes.path).toBe(`/p/${saveRes.page_id}`);
    expect(saveRes.status).toBe('draft');

    // Step 5: Connect Lead Form to CRM
    const connectRes = (await (tools.connect_form_to_crm as any).execute(
      {
        page_id: saveRes.page_id,
        form_id: formRes.form_id,
      },
      opts,
    )) as { ok: boolean; status: string };

    expect(connectRes.ok).toBe(true);
    expect(connectRes.status).toBe('connected');

    // Step 6: Preview page
    const previewRes = (await (tools.preview_landing_page as any).execute(
      { page_id: saveRes.page_id },
      opts,
    )) as { ok: boolean; preview_path: string };

    expect(previewRes.ok).toBe(true);
    expect(previewRes.preview_path).toBe(`/p/${saveRes.page_id}`);

    // Verify stored page
    const stored = store.landingPages.get(saveRes.page_id);
    expect(stored).toBeDefined();
    expect(stored?.name).toBe('Young Lecturer Programme 2027');
    expect(stored?.form_id).toBe(formRes.form_id);
    expect(stored?.status).toBe('draft');
  });

  it('updates an existing landing page content and replaces image', async () => {
    const { client, store } = createMockSupabase();
    const pageId = 'page-existing-1';
    store.landingPages.set(pageId, {
      id: pageId,
      org_id: 'org-test',
      name: 'Initial Name',
      headline: 'Old Headline',
      body: 'Old body',
      status: 'draft',
    });

    const ctx: SharedToolContext = {
      agent: 'kasturi',
      client,
      orgId: 'org-test',
      canWrite: true,
    };

    const tools = createSharedTools(ctx);
    const opts = { toolCallId: 'test-upd', messages: [], context: {} } as any;

    const updateRes = (await (tools.update_landing_page as any).execute(
      {
        page_id: pageId,
        headline: 'New Exciting Headline',
        hero_image_url: 'https://v3.fal.media/files/new-hero.webp',
        button_label: 'Join Today',
      },
      opts,
    )) as { ok: boolean; page_id: string };

    expect(updateRes.ok).toBe(true);
    expect(updateRes.page_id).toBe(pageId);

    const stored = store.landingPages.get(pageId);
    expect(stored?.headline).toBe('New Exciting Headline');
    expect(stored?.body).toContain('https://v3.fal.media/files/new-hero.webp');
  });
});
