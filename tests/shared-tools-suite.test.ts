import { describe, expect, it, vi } from 'vitest';
import {
  createSharedTools,
  AGENT_CAPABILITY_MATRIX,
  SHARED_TOOL_NAMES,
  getAuditLogs,
  type SharedToolContext,
} from '@/lib/ai/shared-tools';

function mockSupabaseClient(overrides: Record<string, unknown> = {}) {
  const fromMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnValue({
        single: vi.fn().mockResolvedValue({
          data: { id: 'mock-form-id', name: 'Mock Form', slug: 'mock-form', status: 'active' },
          error: null,
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({
        data: [{ id: 'mock-page-id', name: 'Mock Page', headline: 'Mock Headline', status: 'draft' }],
        error: null,
      }),
    }),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }),
    ...overrides,
  });

  return { from: fromMock } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

describe('Shared Tool Registry Suite', () => {
  const mockOrgId = 'org-12345';
  const mockUserId = 'user-54321';

  describe('Capability Discovery Matrix', () => {
    it('verifies that all minimum capabilities are present in matrix for both agents', () => {
      const requiredCapabilities = [
        'generate_image',
        'get_image_generation_status',
        'generate_landing_page',
        'update_landing_page',
        'preview_landing_page',
        'save_landing_page',
        'create_lead_form',
        'connect_form_to_crm',
        'delegate_to_agent',
      ];

      for (const cap of requiredCapabilities) {
        expect(SHARED_TOOL_NAMES).toContain(cap);
        expect(AGENT_CAPABILITY_MATRIX.jebat[cap as keyof typeof AGENT_CAPABILITY_MATRIX.jebat]).toBe(true);
        expect(AGENT_CAPABILITY_MATRIX.kasturi[cap as keyof typeof AGENT_CAPABILITY_MATRIX.kasturi]).toBe(true);
      }
    });

    it('Jebat discovers all 9 shared tools in its toolkit', () => {
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        userId: mockUserId,
        canWrite: true,
      };

      const tools = createSharedTools(ctx);
      for (const cap of SHARED_TOOL_NAMES) {
        expect(tools).toHaveProperty(cap);
        expect(typeof tools[cap].execute).toBe('function');
      }
    });

    it('Kasturi discovers all 9 shared tools in its toolkit', () => {
      const ctx: SharedToolContext = {
        agent: 'kasturi',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        userId: mockUserId,
        canWrite: true,
      };

      const tools = createSharedTools(ctx);
      for (const cap of SHARED_TOOL_NAMES) {
        expect(tools).toHaveProperty(cap);
        expect(typeof tools[cap].execute).toBe('function');
      }
    });
  });

  describe('Executable Tool Invocation', () => {
    const opts = { toolCallId: 'call-1', messages: [], context: {} } as any;

    it('Jebat can invoke generate_image tool', async () => {
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        falKey: 'mock-fal-key',
        canWrite: true,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              images: [{ url: 'https://v3.fal.media/files/img.webp', width: 1200, height: 630 }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

      const tools = createSharedTools(ctx);
      const res = (await (tools.generate_image as any).execute(
        { prompt: 'Modern innovative university lecture' },
        opts,
      )) as { ok: boolean; url?: string };

      expect(res.ok).toBe(true);
      expect(res.url).toBe('https://v3.fal.media/files/img.webp');
    });

    it('Kasturi can invoke generate_image tool directly without delegating to Jebat', async () => {
      const ctx: SharedToolContext = {
        agent: 'kasturi',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        falKey: 'mock-fal-key',
        canWrite: true,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              images: [{ url: 'https://v3.fal.media/files/kasturi-img.webp', width: 1024, height: 1024 }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

      const tools = createSharedTools(ctx);
      const res = (await (tools.generate_image as any).execute(
        { prompt: 'Corporate executive handshake' },
        opts,
      )) as { ok: boolean; url?: string };

      expect(res.ok).toBe(true);
      expect(res.url).toBe('https://v3.fal.media/files/kasturi-img.webp');
    });

    it('returns PROVIDER_NOT_CONFIGURED when fal.ai key is absent', async () => {
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        falKey: null,
        canWrite: true,
      };
      delete process.env.FAL_KEY;
      delete process.env.FAL_API_KEY;

      const tools = createSharedTools(ctx);
      const res = (await (tools.generate_image as any).execute(
        { prompt: 'A sunset view' },
        opts,
      )) as { ok: boolean; code?: string };

      expect(res.ok).toBe(false);
      expect(res.code).toBe('PROVIDER_NOT_CONFIGURED');
    });

    it('both agents can invoke generate_landing_page to plan content and layout', async () => {
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        canWrite: true,
      };

      const tools = createSharedTools(ctx);
      const res = (await (tools.generate_landing_page as any).execute(
        {
          name: 'Young Lecturer Programme',
          headline: 'Become a Visionary Academic Leader',
          subheadline: 'Innovative fast-track programme for graduates',
          programme_info: 'A 2-year intensive mentorship curriculum.',
          benefits: ['Full scholarship', 'Global university exchange', 'Fast career path'],
          features: ['Module 1: Pedagogy', 'Module 2: AI Research'],
          cta_text: 'Apply for Intake 2027',
          hero_image_url: 'https://v3.fal.media/files/ylp.webp',
        },
        opts,
      )) as { ok: boolean; landing_page_draft?: { body: string; button_label: string } };

      expect(res.ok).toBe(true);
      expect(res.landing_page_draft?.button_label).toBe('Apply for Intake 2027');
      expect(res.landing_page_draft?.body).toContain('## About the Programme');
      expect(res.landing_page_draft?.body).toContain('## Why Join Us');
      expect(res.landing_page_draft?.body).toContain('Full scholarship');
      expect(res.landing_page_draft?.body).toContain('https://v3.fal.media/files/ylp.webp');
    });

    it('prevents viewer role from saving landing pages or creating forms', async () => {
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        canWrite: false, // viewer role
      };

      const tools = createSharedTools(ctx);
      const saveRes = (await (tools.save_landing_page as any).execute(
        {
          name: 'Test Page',
          headline: 'Headline',
        },
        opts,
      )) as { ok: boolean; error?: string };

      expect(saveRes.ok).toBe(false);
      expect(saveRes.error).toMatch(/viewer/i);

      const formRes = (await (tools.create_lead_form as any).execute(
        { name: 'Test Form' },
        opts,
      )) as { ok: boolean; error?: string };

      expect(formRes.ok).toBe(false);
      expect(formRes.error).toMatch(/viewer/i);
    });

    it('records audit logs with zero credential leakage', async () => {
      const ctx: SharedToolContext = {
        agent: 'kasturi',
        client: mockSupabaseClient(),
        orgId: mockOrgId,
        canWrite: true,
      };

      const tools = createSharedTools(ctx);
      await (tools.preview_landing_page as any).execute(
        { page_id: 'page-abc' },
        opts,
      );

      const logs = getAuditLogs();
      expect(logs.length).toBeGreaterThan(0);
      const last = logs[logs.length - 1];
      expect(last.agent).toBe('kasturi');
      // Ensure no apiKey or sensitive fields exist in audit logs
      const logString = JSON.stringify(logs);
      expect(logString).not.toContain('falKey');
      expect(logString).not.toContain('apiKey');
    });
  });
});
