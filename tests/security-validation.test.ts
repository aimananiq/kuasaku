import { describe, expect, it, vi } from 'vitest';
import {
  validateFalImageOrigin,
  generateFalImage,
  FalError,
} from '@/lib/ai/fal-provider';
import {
  createSharedTools,
  getAuditLogs,
  type SharedToolContext,
} from '@/lib/ai/shared-tools';

describe('Security Validation Suite', () => {
  describe('Credential Protection & Zero Secret Leakage', () => {
    it('never includes raw API key in FalError messages', async () => {
      const sensitiveKey = 'fal_sk_super_secret_production_key_abcdef123456';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(JSON.stringify({ detail: 'Forbidden' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );

      try {
        await generateFalImage(sensitiveKey, { prompt: 'Test' });
        expect.unreachable('Should have thrown FalError');
      } catch (err) {
        expect(err).toBeInstanceOf(FalError);
        const errMsg = (err as Error).message;
        expect(errMsg).not.toContain(sensitiveKey);
        expect(errMsg).not.toContain('abcdef123456');
      }
    });

    it('never logs raw credentials into audit logs', async () => {
      const mockClient = {
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({ data: { id: 'mock-id' }, error: null }),
        }),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;

      const sensitiveFalKey = 'fal_sk_999998888877777';
      const ctx: SharedToolContext = {
        agent: 'jebat',
        client: mockClient,
        orgId: 'tenant-123',
        falKey: sensitiveFalKey,
        canWrite: true,
      };

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              images: [{ url: 'https://v3.fal.media/files/pic.webp' }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );

      const tools = createSharedTools(ctx);
      const opts = { toolCallId: 'sec-call', messages: [], context: {} } as any;
      await (tools.generate_image as any).execute(
        { prompt: 'Generate secure picture' },
        opts,
      );

      const allLogs = getAuditLogs();
      const stringified = JSON.stringify(allLogs);
      expect(stringified).not.toContain(sensitiveFalKey);
      expect(stringified).not.toContain('999998888877777');
    });
  });

  describe('SSRF & Remote Asset Protection', () => {
    it('blocks loopback (127.0.0.1, localhost) SSRF attacks', () => {
      expect(validateFalImageOrigin('http://127.0.0.1:8080/secret')).toBe(false);
      expect(validateFalImageOrigin('https://localhost/admin')).toBe(false);
      expect(validateFalImageOrigin('https://127.0.0.1/config.json')).toBe(false);
    });

    it('blocks cloud metadata service IP (169.254.169.254)', () => {
      expect(
        validateFalImageOrigin('http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
      ).toBe(false);
      expect(
        validateFalImageOrigin('https://169.254.169.254/computeMetadata/v1/'),
      ).toBe(false);
    });

    it('blocks private internal subnet IPs (RFC 1918)', () => {
      expect(validateFalImageOrigin('https://10.0.0.1/private-data')).toBe(false);
      expect(validateFalImageOrigin('https://192.168.1.1/router-settings')).toBe(false);
      expect(validateFalImageOrigin('https://172.16.0.1/internal')).toBe(false);
    });

    it('blocks arbitrary third-party or untrusted attacker domains', () => {
      expect(validateFalImageOrigin('https://evil-attacker.com/malware.png')).toBe(false);
      expect(validateFalImageOrigin('https://fal.media.attacker.com/fake.png')).toBe(false);
      expect(validateFalImageOrigin('javascript:alert(1)')).toBe(false);
    });

    it('only permits authentic fal.media and fal.run subdomains over HTTPS', () => {
      expect(validateFalImageOrigin('https://v3.fal.media/files/img.webp')).toBe(true);
      expect(validateFalImageOrigin('https://fal.media/asset.png')).toBe(true);
      expect(validateFalImageOrigin('https://queue.fal.run/job.png')).toBe(true);
    });
  });

  describe('Tenant Isolation & Authorization', () => {
    it('enforces tenant orgId across queries and forbids cross-tenant access', async () => {
      const mockSelect = vi.fn().mockResolvedValue({ data: [], error: null });
      const mockEq2 = vi.fn().mockReturnValue({ select: mockSelect });
      const mockEq1 = vi.fn().mockReturnValue({ eq: mockEq2 });
      const mockUpdate = vi.fn().mockReturnValue({ eq: mockEq1 });
      const mockFrom = vi.fn().mockReturnValue({ update: mockUpdate });

      const client = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient;

      const ctx: SharedToolContext = {
        agent: 'jebat',
        client,
        orgId: 'tenant-alpha-org',
        canWrite: true,
      };

      const tools = createSharedTools(ctx);
      const opts = { toolCallId: 'sec-upd', messages: [], context: {} } as any;
      await (tools.update_landing_page as any).execute(
        { page_id: 'page-beta', headline: 'Cross-tenant attempt' },
        opts,
      );

      // Verify that org_id was bound in the query
      expect(mockFrom).toHaveBeenCalledWith('crm_landing_pages');
      expect(mockEq2).toHaveBeenCalledWith('org_id', 'tenant-alpha-org');
    });

    it('enforces role permission check: blocks non-writer (viewer) from executing mutations', async () => {
      const client = {
        from: vi.fn(),
      } as unknown as import('@supabase/supabase-js').SupabaseClient;

      const ctx: SharedToolContext = {
        agent: 'kasturi',
        client,
        orgId: 'org-viewer-test',
        role: 'viewer',
        canWrite: false, // Viewer role
      };

      const tools = createSharedTools(ctx);
      const opts = { toolCallId: 'call-unauth', messages: [], context: {} } as any;
      const res = (await (tools.save_landing_page as any).execute(
        { name: 'Unauthorized Page', headline: 'Hacked' },
        opts,
      )) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/viewer role cannot save/i);
    });
  });
});
