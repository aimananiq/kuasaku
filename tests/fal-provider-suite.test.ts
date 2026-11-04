import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAL_MODEL_ALLOWLIST,
  DEFAULT_FAL_MODEL,
  generateFalImage,
  resolveFalApiKey,
  validateFalImageOrigin,
  validateImageMagicBytes,
  checkFalHealth,
  assertAllowedModel,
  FalError,
} from '@/lib/ai/fal-provider';

const mockJsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('fal.ai Provider Integration Suite', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('API Key Resolution', () => {
    it('resolves key from process.env.FAL_KEY fallback', async () => {
      process.env.FAL_KEY = 'fal_sk_test_key_12345';
      const key = await resolveFalApiKey(null, null);
      expect(key).toBe('fal_sk_test_key_12345');
    });

    it('returns null when no key is configured', async () => {
      delete process.env.FAL_KEY;
      delete process.env.FAL_API_KEY;
      delete process.env.OPENKUASA_FAL_KEY;
      const key = await resolveFalApiKey(null, null);
      expect(key).toBeNull();
    });

    it('throws PROVIDER_NOT_CONFIGURED when generating image without key', async () => {
      await expect(
        generateFalImage('', { prompt: 'a cute kitten' }),
      ).rejects.toThrowError(/PROVIDER_NOT_CONFIGURED/);
    });
  });

  describe('Model Allowlist & Validation', () => {
    it('defaults to fal-ai/flux-2', () => {
      expect(DEFAULT_FAL_MODEL).toBe('fal-ai/flux-2');
      expect(assertAllowedModel()).toBe('fal-ai/flux-2');
    });

    it('allows valid models in allowlist', () => {
      for (const model of FAL_MODEL_ALLOWLIST) {
        expect(assertAllowedModel(model)).toBe(model);
      }
    });

    it('rejects unapproved or arbitrary model endpoints', () => {
      expect(() => assertAllowedModel('fal-ai/arbitrary-untrusted-model')).toThrow(
        /not permitted/,
      );
    });
  });

  describe('Request Execution & Error Handling', () => {
    it('successfully generates image and returns real URL and parameters', async () => {
      const mockResult = {
        images: [
          {
            url: 'https://v3.fal.media/files/elephant/123.webp',
            width: 1024,
            height: 768,
            content_type: 'image/webp',
          },
        ],
        seed: 42,
      };

      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse(mockResult));
      vi.stubGlobal('fetch', fetchMock);

      const res = await generateFalImage('test-fal-key', {
        prompt: 'Modern university lecture hall',
        image_size: 'landscape_16_9',
        model: 'fal-ai/flux-2',
      });

      expect(res.url).toBe('https://v3.fal.media/files/elephant/123.webp');
      expect(res.model).toBe('fal-ai/flux-2');
      expect(res.prompt).toBe('Modern university lecture hall');
      expect(res.width).toBe(1024);
      expect(res.seed).toBe(42);

      // Verify request headers and payload
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0];
      expect(call[0]).toBe('https://fal.run/fal-ai/flux-2');
      expect(call[1].headers.Authorization).toBe('Key test-fal-key');
    });

    it('handles authentication failure (HTTP 401)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ detail: 'Unauthorized' }, 401)));

      await expect(
        generateFalImage('bad-key', { prompt: 'Test' }),
      ).rejects.toThrowError(/authentication failed/);
    });

    it('handles insufficient credits (HTTP 402)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ detail: 'Payment required' }, 402)));

      await expect(
        generateFalImage('good-key', { prompt: 'Test' }),
      ).rejects.toThrowError(/insufficient balance/);
    });

    it('handles rate limits (HTTP 429)', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ detail: 'Rate limit' }, 429)));

      await expect(
        generateFalImage('good-key', { prompt: 'Test' }),
      ).rejects.toThrowError(/rate limit exceeded/);
    });

    it('handles missing image output from successful HTTP response', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ images: [] })));

      await expect(
        generateFalImage('good-key', { prompt: 'Test' }),
      ).rejects.toThrowError(/returned a response with no image files/);
    });
  });

  describe('SSRF & MIME Type Protection', () => {
    it('accepts authentic fal.media and fal.run origins', () => {
      expect(validateFalImageOrigin('https://v3.fal.media/files/abc.webp')).toBe(true);
      expect(validateFalImageOrigin('https://fal.media/files/abc.png')).toBe(true);
      expect(validateFalImageOrigin('https://queue.fal.run/results/abc.png')).toBe(true);
    });

    it('blocks untrusted, local, or SSRF-prone URLs', () => {
      expect(validateFalImageOrigin('http://v3.fal.media/files/abc.webp')).toBe(false); // HTTP not HTTPS
      expect(validateFalImageOrigin('https://attacker.com/fake.png')).toBe(false);
      expect(validateFalImageOrigin('https://169.254.169.254/latest/meta-data')).toBe(false);
      expect(validateFalImageOrigin('https://127.0.0.1/admin')).toBe(false);
      expect(validateFalImageOrigin('https://localhost:3000/image.png')).toBe(false);
    });

    it('validates magic bytes for JPEG, PNG and WebP', () => {
      // JPEG
      const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
      expect(validateImageMagicBytes(jpegBytes)).toEqual({ valid: true, mimeType: 'image/jpeg' });

      // PNG
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
      expect(validateImageMagicBytes(pngBytes)).toEqual({ valid: true, mimeType: 'image/png' });

      // WebP
      const webpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(validateImageMagicBytes(webpBytes)).toEqual({ valid: true, mimeType: 'image/webp' });

      // Corrupted / unknown
      const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
      expect(validateImageMagicBytes(junk).valid).toBe(false);
    });
  });

  describe('Provider Health Check', () => {
    it('returns unconfigured when no key is set', async () => {
      const health = await checkFalHealth('', null);
      expect(health.configured).toBe(false);
      expect(health.authVerified).toBe(false);
      expect(health.defaultModel).toBe('fal-ai/flux-2');
    });

    it('verifies auth when probe returns non-401/403 status', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ detail: 'Job not found' }, 404)));
      const health = await checkFalHealth('valid-key', null);
      expect(health.configured).toBe(true);
      expect(health.authVerified).toBe(true);
      expect(health.lastError).toBeNull();
    });

    it('detects authentication rejection on 401', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockJsonResponse({ detail: 'Unauthorized' }, 401)));
      const health = await checkFalHealth('invalid-key', null);
      expect(health.configured).toBe(true);
      expect(health.authVerified).toBe(false);
      expect(health.lastError).toMatch(/rejected/i);
    });
  });
});
