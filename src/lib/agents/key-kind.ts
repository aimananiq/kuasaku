import { decodeKeyRef } from '@/lib/ai/providers';

/** True when a workspace key (as `readWorkspaceKey` returns it) is for a provider other than OpenRouter. */
export const isDirectKey = (keyRef: string): boolean => {
  const p = decodeKeyRef(keyRef).provider;
  return p !== null && p !== 'openrouter';
};
