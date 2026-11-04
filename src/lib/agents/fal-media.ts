/**
 * The fal.ai media seam for the autonomous agent worker.
 *
 * Mirrors the image and video half of openrouter-media.ts, with the same result
 * types, so an agent step can use either. Every call takes the workspace's
 * already-opened fal key as its first param; this module never reads, opens or
 * logs keys. fal does not report what a call cost, so `cost_cents` is always
 * `null` and the caller books the step's estimate (see costs.ts).
 */

import type { ImageResult, VideoCheck, VideoStart } from '@/lib/agents/openrouter-media';

/** Override per self-hoster; any fal app that takes `{ prompt }` and returns `images[0]` / `video` works. */
const IMAGE_MODEL = () => process.env.OPENKUASA_MODEL_FAL_IMAGE?.trim() || 'fal-ai/flux/schnell';
const VIDEO_MODEL = () => process.env.OPENKUASA_MODEL_FAL_VIDEO?.trim() || 'fal-ai/ltx-video';

const SYNC_BASE = 'https://fal.run';
const QUEUE_BASE = 'https://queue.fal.run';

/** A stored video job id from fal starts with this, so the poller knows whose job it is. */
export const FAL_JOB_PREFIX = 'fal:';

export function isFalJob(jobId: string | null | undefined): jobId is string {
  return typeof jobId === 'string' && jobId.startsWith(FAL_JOB_PREFIX);
}

function headers(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
}

/** Only fal's own queue is ever called with the key. */
function isQueueUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith(`${QUEUE_BASE}/`);
}

/** A model id is `owner/app[/path]`: letters, digits and a few separators, nothing that could leave the host. */
function assertModel(model: string): string {
  if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(model)) throw new Error('Invalid fal model id.');
  return model;
}

export async function generateImage(apiKey: string, prompt: string): Promise<ImageResult> {
  const res = await fetch(`${SYNC_BASE}/${assertModel(IMAGE_MODEL())}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ prompt, image_size: 'landscape_4_3', num_images: 1 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`fal image failed (${res.status}).`);
  const json = (await res.json()) as { images?: { url?: string; content_type?: string }[] };
  const image = json.images?.[0];
  if (!image?.url || !/^https:\/\//.test(image.url)) throw new Error('fal image returned no file.');
  // The file URL is a public CDN link; no key is sent with it.
  const file = await fetch(image.url, { signal: AbortSignal.timeout(60_000) });
  if (!file.ok) throw new Error('fal image download failed.');
  return {
    bytes: new Uint8Array(await file.arrayBuffer()),
    contentType: image.content_type || file.headers.get('content-type') || 'image/jpeg',
    cost_cents: null,
  };
}

/**
 * Starts an async video job. The job id carries the two URLs fal gave back
 * (`fal:<status url>|<result url>`), because they are not derivable from the
 * request id alone for every app; checkVideo only calls them after confirming
 * they are on fal's queue host.
 */
export async function startVideo(apiKey: string, prompt: string): Promise<VideoStart> {
  const res = await fetch(`${QUEUE_BASE}/${assertModel(VIDEO_MODEL())}`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify({ prompt }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`fal video start failed (${res.status}).`);
  const json = (await res.json()) as { status_url?: string; response_url?: string };
  if (!isQueueUrl(json.status_url) || !isQueueUrl(json.response_url)) {
    throw new Error('fal video start returned no job.');
  }
  return { jobId: `${FAL_JOB_PREFIX}${json.status_url}|${json.response_url}`, cost_cents: null };
}

export async function checkVideo(apiKey: string, jobId: string): Promise<VideoCheck> {
  const [statusUrl, resultUrl] = jobId.slice(FAL_JOB_PREFIX.length).split('|');
  if (!isQueueUrl(statusUrl) || !isQueueUrl(resultUrl)) return { status: 'failed', cost_cents: null };

  const statusRes = await fetch(statusUrl, { headers: headers(apiKey), signal: AbortSignal.timeout(30_000) });
  if (!statusRes.ok) throw new Error(`fal video status failed (${statusRes.status}).`);
  const status = ((await statusRes.json()) as { status?: string }).status;
  if (status !== 'COMPLETED') return { status: 'pending' };

  const resultRes = await fetch(resultUrl, { headers: headers(apiKey), signal: AbortSignal.timeout(30_000) });
  // A finished job whose result cannot be read is a failed one, not a pending one.
  if (!resultRes.ok) return { status: 'failed', cost_cents: null };
  const result = (await resultRes.json()) as { video?: { url?: string } };
  const url = result.video?.url;
  if (!url || !/^https:\/\//.test(url)) return { status: 'failed', cost_cents: null };
  return { status: 'done', url, cost_cents: null };
}
