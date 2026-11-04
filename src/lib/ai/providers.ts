/**
 * The AI providers a workspace can bring its own key for.
 *
 * Pure data and small helpers, safe on server and client. A key's provider is
 * read from its shape, so the code that builds a model from "an API key" needs
 * no extra argument.
 */

export const AI_PROVIDERS = [
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'xai',
  'mistral',
  'groq',
  'together',
  'moonshot',
  'qwen',
] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

type ProviderInfo = {
  label: string;
  /** What a key looks like, shown as the field's placeholder. */
  placeholder: string;
  /** Where to create a key. */
  keysUrl: string;
  /** What is shown of a saved key before its last four characters. */
  hintPrefix: string;
  /** A cheap check before any network call. */
  shape: RegExp;
  /** A short sentence for a key that fails the check. */
  shapeHint: string;
  /**
   * True when the key's own shape names the provider (so a bare key can be told
   * apart). The rest share `sk-` or have no prefix, and are tracked by the
   * provider saved with them (see encodeKeyRef).
   */
  native: boolean;
};

const generic = /^[A-Za-z0-9._-]{16,300}$/;

export const PROVIDER_INFO: Record<AiProvider, ProviderInfo> = {
  openrouter: {
    label: 'OpenRouter',
    placeholder: 'sk-or-v1-…',
    keysUrl: 'https://openrouter.ai/keys',
    hintPrefix: 'sk-or-',
    shape: /^sk-or-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-or-.',
    native: true,
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    placeholder: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    hintPrefix: 'sk-ant-',
    shape: /^sk-ant-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-ant-.',
    native: true,
  },
  openai: {
    label: 'OpenAI',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
    hintPrefix: 'sk-',
    // `sk-or-` and `sk-ant-` belong to the two above, so they are excluded here.
    shape: /^sk-(?!or-|ant-)[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-.',
    native: true,
  },
  google: {
    label: 'Google (Gemini)',
    placeholder: 'AIza…',
    keysUrl: 'https://aistudio.google.com/apikey',
    hintPrefix: 'AIza',
    shape: /^AIza[A-Za-z0-9_-]{20,100}$/,
    shapeHint: 'It should start with AIza.',
    native: true,
  },
  deepseek: {
    label: 'DeepSeek',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    hintPrefix: 'sk-',
    shape: /^sk-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-.',
    native: false,
  },
  xai: {
    label: 'xAI (Grok)',
    placeholder: 'xai-…',
    keysUrl: 'https://console.x.ai',
    hintPrefix: 'xai-',
    shape: /^xai-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with xai-.',
    native: false,
  },
  mistral: {
    label: 'Mistral',
    placeholder: 'Mistral API key',
    keysUrl: 'https://console.mistral.ai/api-keys',
    hintPrefix: 'key',
    shape: generic,
    shapeHint: 'Check that you copied the whole key.',
    native: false,
  },
  groq: {
    label: 'Groq',
    placeholder: 'gsk_…',
    keysUrl: 'https://console.groq.com/keys',
    hintPrefix: 'gsk_',
    shape: /^gsk_[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with gsk_.',
    native: false,
  },
  together: {
    label: 'Together AI',
    placeholder: 'Together API key',
    keysUrl: 'https://api.together.ai/settings/api-keys',
    hintPrefix: 'key',
    shape: generic,
    shapeHint: 'Check that you copied the whole key.',
    native: false,
  },
  moonshot: {
    label: 'Moonshot (Kimi)',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.moonshot.ai/console/api-keys',
    hintPrefix: 'sk-',
    shape: /^sk-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-.',
    native: false,
  },
  qwen: {
    label: 'Alibaba Qwen',
    placeholder: 'sk-…',
    keysUrl: 'https://bailian.console.alibabacloud.com/?apiKey=1',
    hintPrefix: 'sk-',
    shape: /^sk-[A-Za-z0-9_-]{16,300}$/,
    shapeHint: 'It should start with sk-.',
    native: false,
  },
};

/**
 * Providers a workspace can bring a key for that are NOT chat providers: they
 * make images and video for the agents. A key for one is saved beside the chat
 * keys but is never the key chat runs on (it is never "in use" for chat).
 */
export const MEDIA_PROVIDERS = ['fal'] as const;
export type MediaProvider = (typeof MEDIA_PROVIDERS)[number];

export const MEDIA_PROVIDER_INFO: Record<MediaProvider, ProviderInfo> = {
  fal: {
    label: 'fal.ai (images and video)',
    placeholder: 'fal key (id:secret)',
    keysUrl: 'https://fal.ai/dashboard/keys',
    hintPrefix: 'fal_',
    // Keys look like `<id>:<secret>`, sometimes with a `fal_sk_` prefix.
    shape: /^[A-Za-z0-9._:-]{16,300}$/,
    shapeHint: 'Check that you copied the whole key.',
    native: false,
  },
};

export function isMediaProvider(value: unknown): value is MediaProvider {
  return typeof value === 'string' && (MEDIA_PROVIDERS as readonly string[]).includes(value);
}

/** A chat provider or a media provider. */
export type KeyProvider = AiProvider | MediaProvider;

export function isKeyProvider(value: unknown): value is KeyProvider {
  return isAiProvider(value) || isMediaProvider(value);
}

export function keyProviderInfo(provider: KeyProvider): ProviderInfo {
  return isMediaProvider(provider) ? MEDIA_PROVIDER_INFO[provider] : PROVIDER_INFO[provider];
}

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === 'string' && (AI_PROVIDERS as readonly string[]).includes(value);
}

/** The provider a bare key belongs to, among those whose keys name them; null when it matches none. */
export function detectProvider(apiKey: string): AiProvider | null {
  const key = apiKey.trim();
  return AI_PROVIDERS.find((p) => PROVIDER_INFO[p].native && PROVIDER_INFO[p].shape.test(key)) ?? null;
}

export function isKeyShapeFor(provider: KeyProvider, apiKey: string): boolean {
  return keyProviderInfo(provider).shape.test(apiKey.trim());
}

/** What is shown about a saved key: its start and its last four characters. */
export function hintFor(provider: KeyProvider, apiKey: string): string {
  return `${keyProviderInfo(provider).hintPrefix}…${apiKey.trim().slice(-4)}`;
}

const REF = 'kr1:';

/**
 * A key as it travels through the app: the bare key when its shape names the
 * provider, otherwise `kr1:<provider>:<key>`, so the model builder knows which
 * provider the key is for without every caller passing it along.
 */
export function encodeKeyRef(provider: AiProvider, apiKey: string): string {
  return PROVIDER_INFO[provider].native ? apiKey : `${REF}${provider}:${apiKey}`;
}

export function decodeKeyRef(ref: string): { provider: AiProvider | null; apiKey: string } {
  if (ref.startsWith(REF)) {
    const rest = ref.slice(REF.length);
    const i = rest.indexOf(':');
    const provider = rest.slice(0, i);
    if (i > 0 && isAiProvider(provider)) return { provider, apiKey: rest.slice(i + 1) };
  }
  return { provider: detectProvider(ref), apiKey: ref };
}
