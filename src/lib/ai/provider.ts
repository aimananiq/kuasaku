/**
 * LLM provider factory for the Ask-Jebat agent.
 *
 * Provider-agnostic by design (AGPL self-hosters swap with env alone): OpenRouter
 * is the default — one key, any model — with the model chosen *per layer* so the
 * orchestrator can run a strong model while sub-agents run a cheap/fast one.
 *
 * The provider instance is created lazily, so importing this module never throws
 * when `OPENROUTER_API_KEY` is unset (keeps builds and unit tests key-free).
 */

import 'server-only';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { decodeKeyRef, type AiProvider } from '@/lib/ai/providers';
import type { LanguageModel } from 'ai';

export type AgentLayer = 'orchestrator' | 'worker';

/** Fallbacks used only when the per-layer env var is unset. Override via env; exact slugs at https://openrouter.ai/models */
const FALLBACK_MODEL: Record<AgentLayer, string> = {
  orchestrator: 'anthropic/claude-sonnet-4.5',
  worker: 'anthropic/claude-haiku-4.5',
};

type EnvLike = Record<string, string | undefined>;

/** Pure model-id resolution (env → fallback), extracted for unit testing. */
export function pickModelId(layer: AgentLayer, env: EnvLike = process.env): string {
  const fromEnv =
    layer === 'orchestrator'
      ? env.OPENKUASA_MODEL_ORCHESTRATOR
      : env.OPENKUASA_MODEL_WORKER;
  return fromEnv?.trim() || FALLBACK_MODEL[layer];
}

/** True when a provider key is configured — lets the route return a clean 503 instead of crashing. */
export function hasProviderKey(env: EnvLike = process.env): boolean {
  return Boolean(env.OPENROUTER_API_KEY?.trim());
}

function createProvider(apiKey: string) {
  return createOpenRouter({
    apiKey,
    // Optional second intermediary (Cloudflare AI Gateway); off unless configured.
    baseURL: process.env.AI_GATEWAY_BASE_URL?.trim() || undefined,
    appName: 'KuasabyRickworks',
    appUrl: 'https://openkuasa.com',
  });
}

/**
 * The OpenRouter session a model's calls belong to. Through OpenRouter one model is served by several providers (for
 * Claude: Anthropic, Amazon, Google), and each keeps its own prompt cache. Without a session OpenRouter keeps calls on
 * one provider only after a cache hit, and guesses the conversation from its first messages, so a call can land on a
 * provider whose cache is cold and pay to write the whole prompt again. With a session it keeps every call on one
 * provider from the first (and still moves when that provider fails). The cached prompt is the same for every user of
 * an assistant, so the session is the model alone: nothing about the workspace or the person is in it.
 */
export const routingSession = (modelId: string) => `openkuasa:${modelId}`.slice(0, 256);

/** A model of `provider`, in its routing session. */
const inSession = (provider: ReturnType<typeof createOpenRouter>, modelId: string): LanguageModel =>
  provider(modelId, { extraBody: { session_id: routingSession(modelId) } });

let platformProvider: ReturnType<typeof createOpenRouter> | null = null;

function getPlatformProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set — chat cannot reach the model.');
  }
  platformProvider ??= createProvider(apiKey);
  return platformProvider;
}

/** Providers reached through an OpenAI-compatible endpoint: where it is, and the default model per layer. */
const COMPATIBLE: Record<
  'deepseek' | 'xai' | 'mistral' | 'groq' | 'together' | 'moonshot' | 'qwen',
  { baseURL: string; models: Record<AgentLayer, string> }
> = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', models: { orchestrator: 'deepseek-chat', worker: 'deepseek-chat' } },
  xai: { baseURL: 'https://api.x.ai/v1', models: { orchestrator: 'grok-4', worker: 'grok-3-mini' } },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    models: { orchestrator: 'mistral-large-latest', worker: 'mistral-small-latest' },
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    models: { orchestrator: 'llama-3.3-70b-versatile', worker: 'llama-3.1-8b-instant' },
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    models: {
      orchestrator: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      worker: 'meta-llama/Llama-3.1-8B-Instruct-Turbo',
    },
  },
  moonshot: {
    baseURL: 'https://api.moonshot.ai/v1',
    models: { orchestrator: 'kimi-k2-0905-preview', worker: 'kimi-k2-0905-preview' },
  },
  qwen: {
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    models: { orchestrator: 'qwen-max', worker: 'qwen-turbo' },
  },
};

/** The OpenAI-compatible endpoint of a provider that has one, else null. */
export function compatibleBaseURL(provider: AiProvider): string | null {
  return provider in COMPATIBLE ? COMPATIBLE[provider as keyof typeof COMPATIBLE].baseURL : null;
}

/** Default model ids for a workspace's own key on each provider other than OpenRouter (whose ids are in FALLBACK_MODEL). */
const DIRECT_MODEL: Record<'anthropic' | 'openai' | 'google', Record<AgentLayer, string>> = {
  anthropic: { orchestrator: 'claude-sonnet-5-5', worker: 'claude-haiku-5-5' },
  openai: { orchestrator: 'gpt-4.1', worker: 'gpt-4.1-mini' },
  google: { orchestrator: 'gemini-2.5-pro', worker: 'gemini-2.5-flash' },
};

/** The model id for a layer on a provider other than OpenRouter; `OPENKUASA_MODEL_<PROVIDER>_<LAYER>` overrides it. */
export function pickDirectModelId(
  provider: Exclude<AiProvider, 'openrouter'>,
  layer: AgentLayer,
  env: EnvLike = process.env,
): string {
  const fromEnv = env[`OPENKUASA_MODEL_${provider.toUpperCase()}_${layer.toUpperCase()}`];
  if (fromEnv?.trim()) return fromEnv.trim();
  return provider in COMPATIBLE
    ? COMPATIBLE[provider as keyof typeof COMPATIBLE].models[layer]
    : DIRECT_MODEL[provider as keyof typeof DIRECT_MODEL][layer];
}

/**
 * The model for a given agent layer. Pass a workspace's own key to bill that
 * workspace (bring-your-own-key); omit it to use the platform key. `apiKey` is
 * a key as `readWorkspaceKey` returns it (see `encodeKeyRef`), which carries
 * its provider: OpenRouter, Anthropic, OpenAI, Google or an OpenAI-compatible
 * one such as DeepSeek.
 */
export function getModel(layer: AgentLayer, keyRef?: string): LanguageModel {
  if (!keyRef) return inSession(getPlatformProvider(), pickModelId(layer));
  // A workspace provider is built per request so keys are never cached.
  const { provider, apiKey } = decodeKeyRef(keyRef);
  switch (provider) {
    case 'anthropic':
      return createAnthropic({ apiKey })(pickDirectModelId('anthropic', layer));
    case 'openai':
      return createOpenAI({ apiKey })(pickDirectModelId('openai', layer));
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(pickDirectModelId('google', layer));
    case 'deepseek':
    case 'xai':
    case 'mistral':
    case 'groq':
    case 'together':
    case 'moonshot':
    case 'qwen':
      return createOpenAI({ apiKey, baseURL: COMPATIBLE[provider].baseURL }).chat(
        pickDirectModelId(provider, layer),
      );
    default:
      return inSession(createProvider(apiKey), pickModelId(layer));
  }
}

/**
 * A model named by the caller, on a workspace's own key and never the
 * platform's: for a feature that takes its model id from its own environment
 * variable and has no fallback id in code (reading a receipt). An empty key or
 * id is refused rather than handed to the provider.
 */
export function getWorkspaceModelById(modelId: string, apiKey: string): LanguageModel {
  if (!apiKey.trim() || !modelId.trim()) throw new Error('A workspace model needs a key and a model id.');
  // Built per request so keys are never cached.
  return inSession(createProvider(apiKey), modelId.trim());
}
