import { beforeEach, describe, expect, it, vi } from 'vitest';

const gen = vi.hoisted(() => ({ generateText: vi.fn(async () => ({ text: 'digest', providerMetadata: undefined })) }));
vi.mock('ai', async (orig) => ({ ...(await orig<typeof import('ai')>()), generateText: gen.generateText }));
const model = vi.hoisted(() => ({ getModel: vi.fn(() => 'direct-model') }));
vi.mock('@/lib/ai/provider', () => model);

import { complete, webSearch } from '@/lib/agents/openrouter-media';
import { isDirectKey } from '@/lib/agents/key-kind';

beforeEach(() => vi.clearAllMocks());

describe('Weekly Studio on a workspace key from another provider', () => {
  it('recognises which keys are not OpenRouter', () => {
    expect(isDirectKey('kr1:deepseek:sk-abcdef0123456789abcd')).toBe(true);
    expect(isDirectKey('sk-or-v1-abcdef0123456789abcdef')).toBe(false);
  });
  it('writes the digest with that provider\'s model and books it at the estimate (no reported cost)', async () => {
    const r = await complete('kr1:deepseek:sk-abcdef0123456789abcd', 'anthropic/claude-sonnet-4.5', 'hi');
    expect(model.getModel).toHaveBeenCalledWith('worker', 'kr1:deepseek:sk-abcdef0123456789abcd');
    expect(r).toEqual({ text: 'digest', cost_cents: null });
  });
  it('does not pretend to have searched the web', async () => {
    await webSearch('kr1:deepseek:sk-abcdef0123456789abcd', 'find angles');
    expect(JSON.stringify(gen.generateText.mock.calls[0])).toContain('no live web access');
  });
});
