import { describe, expect, it, vi } from 'vitest';
import { fakeSupabase } from './helpers/fake-supabase';

vi.mock('server-only', () => ({}));
const svc = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => svc.db }));

import { craftImagePrompt, isOwnImage, isShowableImage, persistGeneratedImage, sniffImage } from '@/lib/media/persist-image';
import { createSharedTools, unshowableImage, type SharedToolContext } from '@/lib/ai/shared-tools';
import { sharedProduct } from '@/lib/ai/products';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
const FAL = 'https://v3.fal.media/files/a/b.png';
const ORG = '11111111-1111-4111-8111-111111111111';

describe('durable images', () => {
  it('recognises images by their bytes, not their name', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>  '))).toBeNull();
  });
  it('stores a fal.ai image in the workspace folder and returns our own URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    const upload = vi.fn(async () => ({ error: null }));
    const service = { storage: { from: () => ({ upload }) } } as never;
    const r = await persistGeneratedImage(service, ORG, FAL, (async () => new Response(PNG)) as typeof fetch);
    expect(r.ok && r.url).toMatch(new RegExp(`^https://proj\\.supabase\\.co/storage/v1/object/public/creative-assets/${ORG}/[0-9a-f-]{36}\\.png$`));
    expect((upload.mock.calls as unknown[][])[0][2]).toMatchObject({ contentType: 'image/png', upsert: false });
    vi.unstubAllEnvs();
  });
  it('refuses a source that is not fal.ai and a file that is not an image', async () => {
    const service = { storage: { from: () => ({ upload: vi.fn() }) } } as never;
    expect((await persistGeneratedImage(service, ORG, 'https://evil.example/a.png')).ok).toBe(false);
    expect((await persistGeneratedImage(service, ORG, FAL, (async () => new Response('<html>')) as typeof fetch)).ok).toBe(false);
  });
  it('only shows our own images for this workspace, or fal.ai drafts', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co');
    const own = `https://proj.supabase.co/storage/v1/object/public/creative-assets/${ORG}/x.png`;
    expect(isOwnImage(own, ORG)).toBe(true);
    expect(isOwnImage(own, 'another-org')).toBe(false);
    expect(isShowableImage('https://tracker.example/pixel.gif', ORG)).toBe(false);
    expect(isShowableImage(FAL, ORG)).toBe(true);
    expect(unshowableImage(`![hero](${FAL})\n\n![x](https://tracker.example/p.gif)`, ORG)).toContain('tracker.example');
    vi.unstubAllEnvs();
  });
  it('enriches a bare prompt, keeps a detailed one, and always forbids text in the image', () => {
    const plain = craftImagePrompt('lecturer teaching students', 'hero');
    expect(plain).toMatch(/negative space/);
    expect(plain).toMatch(/no text/);
    const detailed = craftImagePrompt('an illustration of a classroom, golden hour lighting, wide shot, no text');
    expect(detailed.match(/no text/g)).toHaveLength(1);
    expect(detailed).not.toMatch(/editorial photography/);
  });
});

const ctx = (db: unknown, canWrite = true): SharedToolContext => ({ agent: 'kasturi', client: db as never, orgId: ORG, userId: 'u1', canWrite });
const run = (tools: ReturnType<typeof createSharedTools>, name: string, input: object) =>
  (tools[name] as unknown as { execute: (i: object, o: object) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] });

describe('forms and landing pages: saved as drafts, published only with approval', () => {
  it('creates a form as a draft with only the columns a form has (no created_by)', async () => {
    const db = fakeSupabase();
    svc.db = db;
    const r = await run(createSharedTools(ctx(db)), 'create_lead_form', { name: 'YLP 2.0', status: 'draft', banner_image_url: FAL });
    expect(r).toMatchObject({ ok: true, status: 'draft', banner_saved: true });
    expect(db.tables.forms[0]).toMatchObject({ status: 'draft', org_id: ORG });
    expect(db.tables.forms[0]).not.toHaveProperty('created_by');
    expect(db.tables.form_banners[0]).toMatchObject({ image_url: FAL });
  });
  it('ignores a banner that is not from fal.ai or this workspace', async () => {
    const db = fakeSupabase();
    svc.db = db;
    const r = await run(createSharedTools(ctx(db)), 'create_lead_form', { name: 'Form', banner_image_url: 'https://tracker.example/p.png' });
    expect(r.ok).toBe(true);
    expect(db.tables.form_banners ?? []).toHaveLength(0);
  });
  it('saves a page as a draft even if asked to publish, and rejects outside images', async () => {
    const db = fakeSupabase();
    const tools = createSharedTools(ctx(db));
    const ok = await run(tools, 'save_landing_page', { name: 'P', headline: 'H', body: `![hero](${FAL})\n\n## Why`, status: 'published' });
    expect(ok).toMatchObject({ ok: true, status: 'draft' });
    expect(db.tables.crm_landing_pages[0].status).toBe('draft');
    const bad = await run(tools, 'save_landing_page', { name: 'P2', headline: 'H', body: '![x](https://tracker.example/p.gif)' });
    expect(bad.ok).toBe(false);
  });
  it('will not publish a page without a connected, active form', async () => {
    const db = fakeSupabase({
      crm_landing_pages: [
        { id: 'p-noform', org_id: ORG, headline: 'H', form_id: null, status: 'draft' },
        { id: 'p-draftform', org_id: ORG, headline: 'H', form_id: 'f1', status: 'draft' },
        { id: 'p-ready', org_id: ORG, headline: 'H', form_id: 'f2', status: 'draft' },
      ],
      forms: [{ id: 'f1', org_id: ORG, status: 'draft' }, { id: 'f2', org_id: ORG, status: 'active' }],
    });
    const tools = createSharedTools(ctx(db));
    expect((await run(tools, 'publish_landing_page', { page_id: '00000000-0000-4000-8000-000000000001' })).ok).toBe(false);
    for (const id of ['p-noform', 'p-draftform']) {
      // ids are matched as UUIDs by the schema in a real call; the tool itself checks workspace, form and status.
      expect((await run(tools, 'publish_landing_page', { page_id: id })).ok).toBe(false);
      expect(db.tables.crm_landing_pages.find((p: { id: string }) => p.id === id).status).toBe('draft');
    }
    expect(await run(tools, 'publish_landing_page', { page_id: 'p-ready' })).toMatchObject({ ok: true, status: 'published', public_path: '/p/p-ready' });
    expect(await run(tools, 'unpublish_landing_page', { page_id: 'p-ready' })).toMatchObject({ ok: true, status: 'draft' });
  });
  it('another workspace\'s page cannot be published, and a viewer cannot publish', async () => {
    const db = fakeSupabase({ crm_landing_pages: [{ id: 'other', org_id: 'someone-else', headline: 'H', form_id: 'f', status: 'draft' }], forms: [{ id: 'f', org_id: 'someone-else', status: 'active' }] });
    expect((await run(createSharedTools(ctx(db)), 'publish_landing_page', { page_id: 'other' })).ok).toBe(false);
    expect((await run(createSharedTools(ctx(db, false)), 'publish_landing_page', { page_id: 'other' })).error).toMatch(/role/);
  });
  it('publishing and unpublishing wait for approval for both agents', () => {
    for (const agent of ['jebat', 'kasturi'] as const) {
      const kit = sharedProduct({ ...ctx(fakeSupabase()), agent });
      expect(Object.keys(kit.write).sort()).toEqual(['publish_landing_page', 'unpublish_landing_page']);
      expect(Object.keys(kit.read)).toEqual(expect.arrayContaining(['generate_image', 'save_landing_page', 'create_lead_form']));
    }
  });
});
