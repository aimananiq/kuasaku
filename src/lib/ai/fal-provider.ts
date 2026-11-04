/**
 * Official fal.ai integration seam for OpenKuasa.
 *
 * Implements:
 * - API key resolution (Database encrypted org_ai_keys -> env var fallback)
 * - Model allowlist with configurable default (fal-ai/flux-2)
 * - Safe request execution with timeout and exponential backoff on transient errors
 * - SSRF prevention for remote asset downloads
 * - Magic-byte MIME type validation and file-size guard
 * - Health check distinguishing configuration, auth verification, and model availability
 * - Zero raw credential leakage in error messages or logs
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { readMediaKey } from '@/lib/ai/media-key';
import { serviceClient } from '@/lib/supabase/service';

export const FAL_MODEL_ALLOWLIST = [
  'fal-ai/flux-2',
  'fal-ai/flux/schnell',
  'fal-ai/flux/dev',
  'fal-ai/flux-pro',
] as const;

export type FalModel = (typeof FAL_MODEL_ALLOWLIST)[number];
export const DEFAULT_FAL_MODEL: FalModel = 'fal-ai/flux-2';

export function getActiveFalModel(): string {
  const envModel = process.env.OPENKUASA_MODEL_FAL_IMAGE?.trim();
  if (envModel && (FAL_MODEL_ALLOWLIST as readonly string[]).includes(envModel)) {
    return envModel;
  }
  return DEFAULT_FAL_MODEL;
}

export type FalErrorCode =
  | 'PROVIDER_NOT_CONFIGURED'
  | 'AUTHENTICATION_FAILED'
  | 'INSUFFICIENT_CREDITS'
  | 'RATE_LIMITED'
  | 'INVALID_MODEL'
  | 'INVALID_INPUT'
  | 'SSRF_BLOCKED'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'STORAGE_FAILED'
  | 'GENERATION_FAILED';

export class FalError extends Error {
  constructor(
    public readonly code: FalErrorCode,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(`[${code}] ${message}`);
    this.name = 'FalError';
  }
}

export type FalImageInput = {
  prompt: string;
  image_size?: 'landscape_16_9' | 'landscape_4_3' | 'square_hd' | 'square' | 'portrait_4_3' | 'portrait_16_9';
  model?: string;
  num_images?: number;
  output_format?: 'webp' | 'jpeg' | 'png';
  timeoutMs?: number;
};

export type FalImageOutput = {
  url: string;
  width?: number;
  height?: number;
  contentType: string;
  bytes?: Uint8Array;
  model: string;
  prompt: string;
  seed?: number;
};

export type FalJobStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export type FalJobStatusResult = {
  status: FalJobStatus;
  requestId: string;
  images?: FalImageOutput[];
  error?: string;
};

export type FalHealthCheck = {
  configured: boolean;
  authVerified: boolean;
  modelAvailable: boolean;
  defaultModel: string;
  lastError: string | null;
};

const SYNC_BASE = 'https://fal.run';
const QUEUE_BASE = 'https://queue.fal.run';
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15MB limit

/**
 * Resolves fal.ai API key:
 * 1. Database encrypted org_ai_keys for current workspace
 * 2. Environment variables FAL_KEY, FAL_API_KEY, OPENKUASA_FAL_KEY
 */
export async function resolveFalApiKey(
  client?: SupabaseClient | null,
  orgId?: string | null,
): Promise<string | null> {
  if (orgId) {
    try {
      const sClient = serviceClient();
      const dbKey = await readMediaKey(sClient, orgId, 'fal');
      if (dbKey) return dbKey;
    } catch {
      // If service client fails or encryption secret is missing, try caller client
      if (client) {
        try {
          const dbKey = await readMediaKey(client, orgId, 'fal');
          if (dbKey) return dbKey;
        } catch {
          // ignore error and fallback to env
        }
      }
    }
  }

  const envKey =
    process.env.FAL_KEY?.trim() ||
    process.env.FAL_API_KEY?.trim() ||
    process.env.OPENKUASA_FAL_KEY?.trim();

  return envKey || null;
}

/**
 * Validates that an image URL originates strictly from fal.ai CDN to prevent SSRF.
 */
export function validateFalImageOrigin(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      hostname === 'fal.media' ||
      hostname.endsWith('.fal.media') ||
      hostname === 'fal.run' ||
      hostname.endsWith('.fal.run')
    );
  } catch {
    return false;
  }
}

/**
 * Magic-byte validation to verify authentic image payload.
 */
export function validateImageMagicBytes(bytes: Uint8Array): { valid: boolean; mimeType: string } {
  if (bytes.length < 12) return { valid: false, mimeType: 'unknown' };

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { valid: true, mimeType: 'image/jpeg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { valid: true, mimeType: 'image/png' };
  }

  // WebP: 'RIFF' .... 'WEBP'
  const isRiff =
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const isWebp =
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (isRiff && isWebp) {
    return { valid: true, mimeType: 'image/webp' };
  }

  return { valid: false, mimeType: 'unknown' };
}

/**
 * Validates and sanitizes model selection against server allowlist.
 */
export function assertAllowedModel(modelInput?: string): string {
  const model = modelInput?.trim() || getActiveFalModel();
  if (!(FAL_MODEL_ALLOWLIST as readonly string[]).includes(model)) {
    throw new FalError(
      'INVALID_MODEL',
      `Model "${model}" is not permitted. Allowed models: ${FAL_MODEL_ALLOWLIST.join(', ')}`,
      400,
    );
  }
  return model;
}

/**
 * Performs a fal.ai generation request with retry on transient server errors.
 */
export async function generateFalImage(
  apiKey: string | null | undefined,
  input: FalImageInput,
  options?: { downloadBytes?: boolean },
): Promise<FalImageOutput> {
  if (!apiKey || apiKey.trim() === '') {
    throw new FalError(
      'PROVIDER_NOT_CONFIGURED',
      'fal.ai API key is not configured for this workspace. Please add your key in Settings.',
      401,
    );
  }

  const model = assertAllowedModel(input.model);
  const prompt = input.prompt?.trim();
  if (!prompt) {
    throw new FalError('INVALID_INPUT', 'Image generation prompt cannot be empty.', 400);
  }

  const payload: Record<string, unknown> = {
    prompt,
    image_size: input.image_size || 'landscape_16_9',
    num_images: input.num_images ?? 1,
    output_format: input.output_format || 'webp',
  };

  const headers = {
    Authorization: `Key ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  };

  const timeoutMs = input.timeoutMs ?? 120_000;
  let lastError: Error | null = null;
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${SYNC_BASE}/${model}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new FalError('AUTHENTICATION_FAILED', 'fal.ai authentication failed. Check your API key.', res.status);
        }
        if (res.status === 402) {
          throw new FalError('INSUFFICIENT_CREDITS', 'fal.ai account has insufficient balance or credits.', res.status);
        }
        if (res.status === 429) {
          throw new FalError('RATE_LIMITED', 'fal.ai rate limit exceeded. Please retry later.', res.status);
        }
        if (res.status >= 500 && attempt < maxRetries) {
          // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          continue;
        }
        throw new FalError('GENERATION_FAILED', `fal.ai image generation failed with HTTP ${res.status}.`, res.status);
      }

      const json = (await res.json()) as {
        images?: { url?: string; width?: number; height?: number; content_type?: string }[];
        seed?: number;
      };

      const img = json.images?.[0];
      if (!img?.url) {
        throw new FalError('GENERATION_FAILED', 'fal.ai returned a response with no image files.', 502);
      }

      if (!validateFalImageOrigin(img.url)) {
        throw new FalError('SSRF_BLOCKED', 'Generated image URL failed origin safety verification.', 403);
      }

      let downloadedBytes: Uint8Array | undefined;
      let contentType = img.content_type || 'image/webp';

      if (options?.downloadBytes) {
        const fileRes = await fetch(img.url, { signal: AbortSignal.timeout(60_000) });
        if (!fileRes.ok) {
          throw new FalError('NETWORK_ERROR', `Failed to download generated image (${fileRes.status}).`, fileRes.status);
        }

        const buffer = await fileRes.arrayBuffer();
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          throw new FalError('STORAGE_FAILED', `Generated image exceeded size limit (${buffer.byteLength} bytes).`, 413);
        }

        downloadedBytes = new Uint8Array(buffer);
        const magic = validateImageMagicBytes(downloadedBytes);
        if (!magic.valid) {
          throw new FalError('INVALID_INPUT', 'Downloaded file is not a valid recognized image format.', 422);
        }
        contentType = magic.mimeType;
      }

      return {
        url: img.url,
        width: img.width,
        height: img.height,
        contentType,
        bytes: downloadedBytes,
        model,
        prompt,
        seed: json.seed,
      };
    } catch (err) {
      if (err instanceof FalError) {
        throw err;
      }
      lastError = err as Error;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  throw new FalError(
    'GENERATION_FAILED',
    lastError ? lastError.message : 'fal.ai image generation failed after retries.',
  );
}

/**
 * Health check for fal.ai provider.
 * Distinguishes:
 * 1. configured: key exists
 * 2. authVerified: key passes authentication probe
 * 3. modelAvailable: default model is allowable
 */
export async function checkFalHealth(
  apiKey?: string | null,
  _orgId?: string | null,
): Promise<FalHealthCheck> {
  const model = getActiveFalModel();
  const modelAvailable = (FAL_MODEL_ALLOWLIST as readonly string[]).includes(model);

  if (!apiKey || apiKey.trim() === '') {
    return {
      configured: false,
      authVerified: false,
      modelAvailable,
      defaultModel: model,
      lastError: 'API key is not configured',
    };
  }

  try {
    // Probing dummy status endpoint tests authentication without generating cost
    const probeRes = await fetch(
      'https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status',
      {
        headers: { Authorization: `Key ${apiKey.trim()}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      },
    );

    if (probeRes.status === 401 || probeRes.status === 403) {
      return {
        configured: true,
        authVerified: false,
        modelAvailable,
        defaultModel: model,
        lastError: 'Authentication rejected by provider',
      };
    }

    // A valid key returns 404 (no such job) or 200, but not 401/403 or 5xx
    const authVerified = probeRes.status < 500;
    return {
      configured: true,
      authVerified,
      modelAvailable,
      defaultModel: model,
      lastError: authVerified ? null : `Provider returned status ${probeRes.status}`,
    };
  } catch {
    return {
      configured: true,
      authVerified: false,
      modelAvailable,
      defaultModel: model,
      lastError: 'Provider unreachable or request timed out',
    };
  }
}
