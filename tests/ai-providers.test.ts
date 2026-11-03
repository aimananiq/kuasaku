import { expect, test } from 'vitest';
import { decodeKeyRef, detectProvider, encodeKeyRef, hintFor, isKeyShapeFor } from '@/lib/ai/providers';
import { pickDirectModelId } from '@/lib/ai/provider';

const body = 'abcdefghijklmnopqrstuvwxyz0123456789';

test('a key is matched to its provider by its start', () => {
  expect(detectProvider(`sk-or-v1-${body}`)).toBe('openrouter');
  expect(detectProvider(`sk-ant-api03-${body}`)).toBe('anthropic');
  expect(detectProvider(`sk-proj-${body}`)).toBe('openai');
  expect(detectProvider(`AIza${body}`)).toBe('google');
  expect(detectProvider('not-a-key')).toBeNull();
});

test('an OpenRouter or Anthropic key is never taken for an OpenAI key', () => {
  expect(isKeyShapeFor('openai', `sk-or-v1-${body}`)).toBe(false);
  expect(isKeyShapeFor('openai', `sk-ant-api03-${body}`)).toBe(false);
});

test('the hint shows the start and the last four characters only', () => {
  expect(hintFor('anthropic', `sk-ant-api03-${body}`)).toBe('sk-ant-…6789');
  expect(hintFor('google', `AIza${body}`)).toBe('AIza…6789');
});

test('a direct provider has a default model per layer, which an env var overrides', () => {
  expect(pickDirectModelId('openai', 'worker', {})).toBeTruthy();
  expect(pickDirectModelId('google', 'orchestrator', { OPENKUASA_MODEL_GOOGLE_ORCHESTRATOR: 'gemini-x' })).toBe('gemini-x');
});

test('a key that does not name its provider travels with it, and a bare key is unchanged', () => {
  const key = `sk-${body}`;
  expect(encodeKeyRef('openai', key)).toBe(key);
  const ref = encodeKeyRef('deepseek', key);
  expect(ref).not.toBe(key);
  expect(decodeKeyRef(ref)).toEqual({ provider: 'deepseek', apiKey: key });
  expect(decodeKeyRef(key)).toEqual({ provider: 'openai', apiKey: key });
});

test('keys of the providers that share the sk- start are checked against their own shape', () => {
  expect(isKeyShapeFor('deepseek', `sk-${body}`)).toBe(true);
  expect(isKeyShapeFor('groq', `gsk_${body}`)).toBe(true);
  expect(isKeyShapeFor('groq', `sk-${body}`)).toBe(false);
  expect(isKeyShapeFor('xai', `xai-${body}`)).toBe(true);
});
