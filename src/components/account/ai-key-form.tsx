'use client';

import { startTransition, useActionState, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  removeAiKeyAction,
  saveAiKeyAction,
  setActiveAiKeyAction,
  testProviderConnectionAction,
} from '@/app/account/ai/actions';
import {
  AI_PROVIDERS,
  MEDIA_PROVIDERS,
  PROVIDER_INFO,
  isMediaProvider,
  keyProviderInfo,
  type KeyProvider,
} from '@/lib/ai/providers';
import { SaveBar } from './settings-form';

export function AiKeyForm({ hasKey }: { hasKey: boolean }) {
  // A native form action clears the field after each submit, which is what a
  // secret input wants.
  const [state, formAction, pending] = useActionState(
    saveAiKeyAction,
    undefined,
  );
  const [provider, setProvider] = useState<KeyProvider>('openrouter');
  const info = keyProviderInfo(provider);
  const media = isMediaProvider(provider);
  const keyField = useRef<HTMLInputElement>(null);

  // Submitted by hand rather than as a form action: React resets every field of a form
  // action, which put the provider list back on OpenRouter while its label still said
  // the chosen provider. Only the secret is cleared.
  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (keyField.current) keyField.current.value = '';
    startTransition(() => formAction(data));
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="ai-provider">Provider</Label>
        <select
          id="ai-provider"
          name="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as KeyProvider)}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          <optgroup label="Chat and the agents">
            {AI_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_INFO[p].label}
              </option>
            ))}
          </optgroup>
          <optgroup label="Images and video">
            {MEDIA_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {keyProviderInfo(p).label}
              </option>
            ))}
          </optgroup>
        </select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="api-key">{info.label} API key</Label>
        <Input
          id="api-key"
          ref={keyField}
          name="apiKey"
          type="password"
          placeholder={info.placeholder}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <p className="text-xs text-muted-foreground">
          Create a key at{' '}
          <a
            href={info.keysUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary hover:underline"
          >
            {info.keysUrl.replace('https://', '')}
          </a>
          . We check it with {info.label}, then store it encrypted. It is never
          shown again; only its last four characters are. Saving a key for a
          provider you already added replaces it.
        </p>
      </div>
      {media ? (
        <p className="text-sm text-muted-foreground">
          This key is for the agents&apos; images and video only. Chat keeps using
          your chat key.
        </p>
      ) : (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="makeActive"
            defaultChecked={!hasKey}
            className="size-4"
          />
          Use this key for chat and the agents
        </label>
      )}
      <SaveBar state={state} pending={pending} label="Save key" />
    </form>
  );
}

/** One saved key: which provider, its hint, and the buttons to use or remove it. */
export function SavedAiKeyRow({
  provider,
  hint,
  active,
  canManage,
}: {
  provider: KeyProvider;
  hint: string;
  active: boolean;
  canManage: boolean;
}) {
  const [useState_, useAction, using] = useActionState(setActiveAiKeyAction, undefined);
  const [removeState, removeAction, removing] = useActionState(removeAiKeyAction, undefined);
  const [testState, testAction, testing] = useActionState(testProviderConnectionAction, undefined);
  const error = useState_?.error ?? removeState?.error ?? testState?.error;
  const notice = testState?.notice;

  return (
    <div className="space-y-1 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{keyProviderInfo(provider).label}</p>
          <p className="text-sm text-muted-foreground">{hint}</p>
          {provider === 'fal' ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              Default model: <span className="font-mono">fal-ai/flux-2</span> &bull; Type: Image Generation
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isMediaProvider(provider) ? (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              Images and video
            </span>
          ) : active ? (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
              In use
            </span>
          ) : canManage ? (
            <form action={useAction}>
              <input type="hidden" name="provider" value={provider} />
              <Button type="submit" variant="outline" size="sm" disabled={using}>
                {using ? 'Switching…' : 'Use this key'}
              </Button>
            </form>
          ) : null}
          {canManage ? (
            <form action={testAction}>
              <input type="hidden" name="provider" value={provider} />
              <Button type="submit" variant="outline" size="sm" disabled={testing}>
                {testing ? 'Testing…' : 'Test connection'}
              </Button>
            </form>
          ) : null}
          {canManage ? (
            <form action={removeAction}>
              <input type="hidden" name="provider" value={provider} />
              <Button type="submit" variant="outline" size="sm" disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      {notice ? (
        <p role="status" className="text-xs text-emerald-600">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
