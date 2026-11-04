import { afterEach, describe, expect, it, vi } from 'vitest';
import { FAL_JOB_PREFIX, checkVideo, generateImage, isFalJob, startVideo } from '@/lib/agents/fal-media';
import {
  MEDIA_PROVIDERS,
  hintFor,
  isAiProvider,
  isKeyProvider,
  isKeyShapeFor,
  isMediaProvider,
} from '@/lib/ai/providers';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const Q = 'https://queue.fal.run/fal-ai/ltx-video/requests/abc';

afterEach(() => vi.unstubAllGlobals());

describe('fal as a key provider', () => {
  it('is a media provider, not a chat provider', () => {
    expect(MEDIA_PROVIDERS).toContain('fal');
    expect(isMediaProvider('fal')).toBe(true);
    expect(isAiProvider('fal')).toBe(false);
    expect(isKeyProvider('fal')).toBe(true);
    expect(isKeyProvider('openrouter')).toBe(true);
    expect(isKeyProvider('nope')).toBe(false);
  });

  it('accepts id:secret keys and rejects junk', () => {
    expect(isKeyShapeFor('fal', 'fal_sk_0123456789abcdef:0123456789abcdef0123')).toBe(true);
    expect(isKeyShapeFor('fal', '0123456789abcdef-0123:secretsecretsecret')).toBe(true);
    expect(isKeyShapeFor('fal', 'short')).toBe(false);
    expect(isKeyShapeFor('fal', 'has spaces in it 0123456789')).toBe(false);
  });

  it('shows a hint the database accepts', () => {
    expect(hintFor('fal', 'fal_sk_0123456789abcdef:0123456789abcdef0123')).toMatch(
      /^[A-Za-z0-9_-]{2,8}…[A-Za-z0-9_-]{4}$/,
    );
  });
});

describe('fal media', () => {
  it('generates an image and reports no cost', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ images: [{ url: 'https://v3.fal.media/files/a.png', content_type: 'image/png' }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetchMock);
    const img = await generateImage('KEY', 'a poster');
    expect(Array.from(img.bytes)).toEqual([1, 2, 3]);
    expect(img.contentType).toBe('image/png');
    expect(img.cost_cents).toBeNull();
    // The key goes to fal only, never to the file download.
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Key KEY');
    expect(fetchMock.mock.calls[1][1]?.headers).toBeUndefined();
  });

  it('fails an image that returns no file', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ images: [] })));
    await expect(generateImage('KEY', 'x')).rejects.toThrow();
  });

  it('starts a video and encodes its job', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ status_url: `${Q}/status`, response_url: Q })),
    );
    const v = await startVideo('KEY', 'clip');
    expect(isFalJob(v.jobId)).toBe(true);
    expect(v.jobId).toBe(`${FAL_JOB_PREFIX}${Q}/status|${Q}`);
    expect(v.cost_cents).toBeNull();
  });

  it('refuses a job whose URLs are not on the fal queue', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(json({ status_url: 'https://evil.example/s', response_url: 'https://evil.example/r' })),
    );
    await expect(startVideo('KEY', 'clip')).rejects.toThrow();
  });

  it('never sends the key to a URL off the fal queue', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const check = await checkVideo('KEY', `${FAL_JOB_PREFIX}https://evil.example/s|https://evil.example/r`);
    expect(check.status).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('polls: pending, then done with the file url', async () => {
    const job = `${FAL_JOB_PREFIX}${Q}/status|${Q}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ status: 'IN_PROGRESS' })));
    expect((await checkVideo('KEY', job)).status).toBe('pending');

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(json({ status: 'COMPLETED' }))
        .mockResolvedValueOnce(json({ video: { url: 'https://v3.fal.media/files/v.mp4' } })),
    );
    expect(await checkVideo('KEY', job)).toEqual({
      status: 'done',
      url: 'https://v3.fal.media/files/v.mp4',
      cost_cents: null,
    });
  });

  it('treats a finished job with an unreadable result as failed', async () => {
    const job = `${FAL_JOB_PREFIX}${Q}/status|${Q}`;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce(json({ status: 'COMPLETED' })).mockResolvedValueOnce(json({}, 422)),
    );
    expect((await checkVideo('KEY', job)).status).toBe('failed');
  });
});
