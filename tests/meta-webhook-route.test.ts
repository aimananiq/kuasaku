import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ rpc: vi.fn(async () => ({ data: null })) }));
vi.mock('@/lib/supabase/service', () => ({ serviceClient: () => ({ rpc: state.rpc }) }));

import { GET, POST } from '@/app/api/meta/webhook/route';

const body = JSON.stringify({ object: 'page', entry: [{ changes: [{ field: 'leadgen', value: { leadgen_id: '123456789', page_id: '99999' } }] }] });
const sign = (b: string, secret = 'appsecret') => 'sha256=' + createHmac('sha256', secret).update(b).digest('hex');
const post = (b: string, sig?: string) => POST(new Request('https://x.test/api/meta/webhook', { method: 'POST', body: b, headers: sig ? { 'x-hub-signature-256': sig } : {} }));

beforeEach(() => { vi.stubEnv('META_APP_SECRET', 'appsecret'); vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', 'verify-me-please'); state.rpc.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

describe('Meta webhook route', () => {
  it('answers the subscription handshake only for the right verify token', async () => {
    const url = (t: string) => new Request(`https://x.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=42`);
    expect(await GET(url('verify-me-please')).text()).toBe('42');
    expect(GET(url('wrong')).status).toBe(403);
  });
  it('rejects missing and invalid signatures before reading anything', async () => {
    expect((await post(body)).status).toBe(401);
    expect((await post(body, sign(body, 'wrong'))).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it('accepts a valid signature; a Page no workspace has connected is ignored, not stored', async () => {
    expect((await post(body, sign(body))).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith('meta_org_for_page', { p_page_id: '99999' });
  });
});
