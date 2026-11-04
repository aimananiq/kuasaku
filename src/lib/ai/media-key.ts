/**
 * Reads and opens a workspace's key for a media provider (fal.ai) on the server.
 *
 * Same rules as workspace-key.ts: the sealed value is read with the service-role
 * client by a workspace id the caller got from trusted state, and is opened only
 * for that workspace. Anything that goes wrong reads as "no key", so a run simply
 * falls back to what it did before.
 */

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptApiKey, hasKeySecret } from '@/lib/ai/key-crypto';
import type { MediaProvider } from '@/lib/ai/providers';

export async function readMediaKey(
  service: SupabaseClient,
  orgId: string,
  provider: MediaProvider,
): Promise<string | null> {
  try {
    if (!hasKeySecret()) return null;
    const { data, error } = await service
      .from('org_ai_keys')
      .select('ciphertext')
      .eq('org_id', orgId)
      .eq('provider', provider)
      .maybeSingle();
    if (error || typeof data?.ciphertext !== 'string' || !data.ciphertext) return null;
    return decryptApiKey(data.ciphertext, orgId);
  } catch {
    return null;
  }
}
