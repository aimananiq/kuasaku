/**
 * Saves a generated image where it will still exist next month. Server-only.
 *
 * fal.ai's URLs are temporary, and a landing page, form, post or ad that points at one breaks when it lapses. So the
 * image is fetched once (only from fal.ai, only if its bytes really are a PNG/JPEG/WebP) and stored in the public
 * `creative-assets` bucket under the workspace's own folder. The caller keeps the returned URL.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { validateFalImageOrigin } from '@/lib/ai/fal-provider';

export const CREATIVE_BUCKET = 'creative-assets';
const MAX_BYTES = 10 * 1024 * 1024;
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** PNG, JPEG or WebP by content, never by what the sender claims. */
export function sniffImage(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

export function publicImageUrl(path: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
  return base ? `${base}/storage/v1/object/public/${CREATIVE_BUCKET}/${path}` : null;
}

export type Persisted = { ok: true; url: string; path: string; contentType: string } | { ok: false; error: string };

export async function persistGeneratedImage(
  service: SupabaseClient,
  orgId: string,
  sourceUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Persisted> {
  if (!validateFalImageOrigin(sourceUrl)) return { ok: false, error: 'The image is not from fal.ai.' };
  try {
    const res = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return { ok: false, error: `Could not download the image (${res.status}).` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) return { ok: false, error: 'The image is larger than 10 MB.' };
    const type = sniffImage(bytes);
    if (!type) return { ok: false, error: 'The file is not a PNG, JPEG or WebP image.' };
    const path = `${orgId}/${randomUUID()}.${EXT[type]}`;
    const { error } = await service.storage.from(CREATIVE_BUCKET).upload(path, bytes, { contentType: type, upsert: false });
    if (error) return { ok: false, error: 'Could not store the image.' };
    const url = publicImageUrl(path);
    return url ? { ok: true, url, path, contentType: type } : { ok: false, error: 'Storage is not configured.' };
  } catch {
    return { ok: false, error: 'Could not download the image.' };
  }
}

/** True for an image URL that lives in our own bucket, for this workspace. Used before a page or form shows it. */
export function isOwnImage(url: string, orgId: string, env: Record<string, string | undefined> = process.env): boolean {
  const prefix = publicImageUrl(`${orgId}/`, env);
  return !!prefix && url.startsWith(prefix) && !url.slice(prefix.length).includes('/') && !url.includes('..');
}

/** An image a page may show: our own copy for this workspace, or (a draft in progress) a fal.ai URL. */
export const isShowableImage = (url: string, orgId: string) => isOwnImage(url, orgId) || validateFalImageOrigin(url);

/** Crafts a richer prompt without overriding what the person asked for. Text inside images comes out garbled, so ask for none. */
export function craftImagePrompt(prompt: string, purpose?: string): string {
  const p = prompt.trim();
  const has = (re: RegExp) => re.test(p);
  const parts = [p];
  if (!has(/\b(photo|photograph|illustration|3d|render|vector|painting|style)\b/i)) parts.push('professional editorial photography, natural colours, shallow depth of field');
  if (!has(/\b(light|lit|lighting|sunlight|golden hour)\b/i)) parts.push('soft natural lighting');
  if (!has(/\b(composition|framing|close-up|wide shot|centered|rule of thirds)\b/i)) {
    parts.push(/hero|banner|landing/i.test(purpose ?? '') ? 'wide composition with calm negative space on one side for a headline' : 'clean, balanced composition');
  }
  if (!has(/\bno text\b/i)) parts.push('no text, no letters, no logos, no watermark');
  return parts.join(', ').slice(0, 1500);
}
