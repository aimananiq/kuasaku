import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { classifyError, graph, graphAll, MetaApiError } from '@/lib/meta/graph';
import { hashState, oauthScopes, sealMetaToken } from '@/lib/meta/connection';
import { decryptApiKey } from '@/lib/ai/key-crypto';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, code: number, message = 'nope') =>
  new Response(JSON.stringify({ error: { message, code } }), { status });
const noSleep = async () => {};

describe('meta graph client', () => {
  it('sends the token in the Authorization header, never in the URL', async () => {
    const f = vi.fn().mockResolvedValue(ok({ id: '1' }));
    await graph('/me', { token: 'SECRET', fetchImpl: f });
    const [url, init] = f.mock.calls[0];
    expect(String(url)).not.toContain('SECRET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer SECRET' });
  });

  it('classifies errors', () => {
    expect(classifyError(400, 190)).toBe('auth');
    expect(classifyError(403, 200)).toBe('permission');
    expect(classifyError(400, 17)).toBe('rate_limit');
    expect(classifyError(500)).toBe('transient');
    expect(classifyError(400, 100)).toBe('invalid');
  });

  it('retries reads on rate limit and then succeeds', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(400, 17)).mockResolvedValueOnce(ok({ id: '1' }));
    await expect(graph('/me', { token: 't', fetchImpl: f, sleep: noSleep })).resolves.toEqual({ id: '1' });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('does not retry an auth error and does not leak the token in the message', async () => {
    const f = vi.fn().mockResolvedValue(fail(400, 190, 'Session expired'));
    const err = (await graph('/me', { token: 'SECRET', fetchImpl: f, sleep: noSleep }).catch((e) => e)) as MetaApiError;
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err.kind).toBe('auth');
    expect(err.message).not.toContain('SECRET');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('rejects path traversal', async () => {
    await expect(graph('/me/../x', { token: 't', fetchImpl: vi.fn() })).rejects.toThrow('Invalid Graph path');
  });

  it('follows pagination', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ data: [{ id: 'a' }], paging: { cursors: { after: 'c1' }, next: 'x' } }))
      .mockResolvedValueOnce(ok({ data: [{ id: 'b' }] }));
    expect(await graphAll('/me/accounts', { token: 't', fetchImpl: f })).toEqual([{ id: 'a' }, { id: 'b' }]);
  });
});

describe('meta credential storage', () => {
  const ORG = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const env = { AI_KEYS_ENCRYPTION_SECRET: 'x'.repeat(40) };

  it('seals per workspace and purpose', () => {
    vi.stubEnv('AI_KEYS_ENCRYPTION_SECRET', env.AI_KEYS_ENCRYPTION_SECRET);
    const sealed = sealMetaToken('EAAB-token', ORG);
    expect(sealed).not.toContain('EAAB');
    expect(decryptApiKey(sealed, ORG, env, 'org-meta-token')).toBe('EAAB-token');
    expect(decryptApiKey(sealed, OTHER, env, 'org-meta-token')).toBeNull(); // cross-tenant
    expect(decryptApiKey(sealed, ORG, env, 'org-ai-key')).toBeNull(); // wrong purpose
  });

  it('hashes OAuth state and requests minimum scopes by default', () => {
    expect(hashState('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(oauthScopes({})).not.toContain('leads_retrieval');
    expect(oauthScopes({ META_OAUTH_SCOPES: 'ads_read, bad scope!' })).toEqual(['ads_read']);
  });
});
