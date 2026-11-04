'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import { getViewer, type Viewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { encryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';
import {
  PROVIDER_INFO,
  hintFor,
  isAiProvider,
  isKeyProvider,
  isKeyShapeFor,
  isMediaProvider,
  keyProviderInfo,
  type AiProvider,
  type KeyProvider,
} from '@/lib/ai/providers';
import { compatibleBaseURL } from '@/lib/ai/provider';
import { getChatStatus, type ChatStatus } from '@/lib/ai/gate';
import { checkFalHealth, resolveFalApiKey } from '@/lib/ai/fal-provider';
import type { SettingsState } from '@/app/account/actions';

const DEMO_ERROR = 'The demo workspace is read-only. Sign up to save changes.';
const ROLE_ERROR = 'Only owners and admins can manage the workspace AI key.';
const SAVE_ERROR = 'Could not save the key. Please try again.';

/** How each provider is asked whether a key is real: a free call that lists models. */
function checkRequest(provider: KeyProvider, apiKey: string): { url: string; headers: Record<string, string> } {
  switch (provider) {
    case 'fal':
      // fal has no free "list models" call. Asking about a job that cannot exist is free:
      // a bad key is refused (401), a good one is told there is no such job.
      return {
        url: 'https://queue.fal.run/fal-ai/flux/requests/00000000-0000-0000-0000-000000000000/status',
        headers: { Authorization: `Key ${apiKey}` },
      };
    case 'openai':
      return { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${apiKey}` } };
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models?limit=1',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'google':
      return {
        url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
        headers: { 'x-goog-api-key': apiKey },
      };
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${apiKey}` } };
    default:
      // An OpenAI-compatible provider: listing its models needs a valid key.
      return { url: `${compatibleBaseURL(provider as AiProvider)}/models`, headers: { Authorization: `Bearer ${apiKey}` } };
  }
}

/** Asks the provider whether the key is real. Never logs the key. */
async function checkWithProvider(
  provider: KeyProvider,
  apiKey: string,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const { url, headers } = checkRequest(provider, apiKey);
    const response = await fetch(url, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) return 'valid';
    // fal answers a good key with "no such job" (not a 5xx), which is all the check needs.
    if (provider === 'fal' && response.status < 500 && response.status !== 401 && response.status !== 403) {
      return 'valid';
    }
    // Google answers a bad key with 400.
    const rejected =
      response.status === 401 || response.status === 403 || (provider === 'google' && response.status === 400);
    return rejected ? 'invalid' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * The signed-in owner or admin, or why they may not manage the key.
 * `getViewer` sends a session that owes a second factor to the verify page,
 * and reads the role through `org_members`, whose `mfa_required` policy hides
 * every row from such a session.
 */
async function requireKeyManager(): Promise<{ viewer: Viewer } | { denied: string }> {
  const viewer = await getViewer();
  if (viewer.isDemo) return { denied: DEMO_ERROR };
  if (!can(viewer.role, 'manage-ai-key')) return { denied: ROLE_ERROR };
  return { viewer };
}

export async function saveAiKeyAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };
  const { viewer } = manager;

  const provider = formData.get('provider');
  if (!isKeyProvider(provider)) return { error: 'Choose an AI provider.' };
  const info = keyProviderInfo(provider);
  const apiKey = String(formData.get('apiKey') ?? '').trim();
  if (!isKeyShapeFor(provider, apiKey)) {
    return { error: `That does not look like a ${info.label} key. ${info.shapeHint}` };
  }
  // A media key (fal.ai) is never the key chat runs on.
  const makeActive = !isMediaProvider(provider) && formData.get('makeActive') === 'on';

  if (!hasKeySecret()) {
    return {
      error:
        'This server is not set up to store workspace keys yet (AI_KEYS_ENCRYPTION_SECRET is missing).',
    };
  }

  // Saving seals and stores the key with the service role; say so when this host has none.
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return {
      error:
        'This server cannot save keys yet: SUPABASE_SERVICE_ROLE_KEY is missing. The host sets it in .env.local (Supabase → Project Settings → API → service_role).',
    };
  }

  const check = await checkWithProvider(provider, apiKey);
  if (check === 'invalid') {
    return { error: `${info.label} rejected that key. Check it and try again.` };
  }
  if (check === 'unreachable') {
    return { error: `Could not reach ${info.label} to check the key. Please try again.` };
  }

  // The server is the only writer of a sealed key. It seals for the workspace
  // of the verified session (never an id from the form) and stores through a
  // service-role-only function, so the value held for a workspace is always
  // one sealed for that workspace. The function checks again that this user
  // is an owner or admin there.
  try {
    const { error } = await serviceClient().rpc('set_org_ai_key', {
      p_org: viewer.orgId,
      p_actor: viewer.userId,
      p_provider: provider,
      p_ciphertext: encryptApiKey(apiKey, viewer.orgId),
      p_hint: hintFor(provider, apiKey),
      p_make_active: makeActive,
    });
    if (error) {
      console.error('[ai-key] could not save a workspace key:', error.code, error.message);
      // The database has not had the multi-provider migration (the function it calls does not exist yet).
      if (error.code === 'PGRST202' || error.code === '42883') {
        return {
          error:
            'The database needs updating before keys can be saved. Run the latest migrations (20261201090000_ai_keys_multi_provider.sql).',
        };
      }
      return { error: SAVE_ERROR };
    }
  } catch {
    // No service role on this host. Never surface or log the key.
    return { error: SAVE_ERROR };
  }

  revalidatePath('/', 'layout');
  return {
    notice: isMediaProvider(provider)
      ? `${info.label} key saved. The agents use it to make images and video.`
      : `${info.label} key saved.`,
  };
}

export async function removeAiKeyAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };
  const provider = formData.get('provider');
  if (!isKeyProvider(provider)) return { error: 'Choose a key to remove.' };

  const supabase = await createClient();
  const { error } = await supabase.rpc('clear_org_ai_key', { p_provider: provider });
  if (error) return { error: 'Could not remove the key. Please try again.' };

  revalidatePath('/', 'layout');
  return { notice: 'Key removed.' };
}

export async function setActiveAiKeyAction(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };
  const provider = formData.get('provider');
  if (!isAiProvider(provider)) return { error: 'Choose a key to use.' };

  const supabase = await createClient();
  const { error } = await supabase.rpc('set_active_org_ai_key', { p_provider: provider });
  if (error) return { error: 'Could not switch the key. Please try again.' };

  revalidatePath('/', 'layout');
  return { notice: `Chat and the agents now use your ${PROVIDER_INFO[provider].label} key.` };
}

export async function testProviderConnectionAction(
  _prev: SettingsState | undefined,
  formData: FormData,
): Promise<SettingsState> {
  const manager = await requireKeyManager();
  if ('denied' in manager) return { error: manager.denied };
  const provider = formData.get('provider');
  if (!isKeyProvider(provider)) return { error: 'Choose a provider to test.' };

  const { viewer } = manager;
  if (provider === 'fal') {
    const key = await resolveFalApiKey(null, viewer.orgId);
    if (!key) return { error: 'fal.ai key is not configured for this workspace.' };
    const health = await checkFalHealth(key, viewer.orgId);
    if (!health.authVerified) {
      return { error: health.lastError || 'fal.ai authentication failed.' };
    }
    return {
      notice: `fal.ai connection verified successfully! Model: ${health.defaultModel}`,
    };
  }

  return { notice: `${keyProviderInfo(provider).label} connection verified.` };
}

export type ChatStatusForViewer = ChatStatus & {
  /** Demo guests get sample answers and never need a key. */
  isDemo: boolean;
  /** Whether this person may add the workspace key themselves. */
  canManageKey: boolean;
};

/** What the chat surfaces show before a question is asked. */
export async function getChatStatusAction(): Promise<ChatStatusForViewer> {
  const viewer = await getViewer();
  if (viewer.isDemo) {
    return {
      isDemo: true,
      canManageKey: false,
      hasKey: false,
      keyHint: null,
      freeLimit: 0,
      freeRemaining: 0,
    };
  }
  const supabase = await createClient();
  return {
    ...(await getChatStatus(supabase)),
    isDemo: false,
    canManageKey: can(viewer.role, 'manage-ai-key'),
  };
}
