'use client';

import { startTransition, useActionState, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  removeAiKeyAction,
  saveAiKeyAction,
  setActiveAiKeyAction,
} from '@/app/account/ai/actions';
import { AI_PROVIDERS, PROVIDER_INFO, type AiProvider } from '@/lib/ai/providers';
import { SaveBar } from './settings-form';

export function AiKeyForm({ hasKey }: { hasKey: boolean }) {
  // A native form action clears the field after each submit, which is what a
  // secret input wants.
  const [state, formAction, pending] = useActionState(
    saveAiKeyAction,
    undefined,
  );
  const [provider, setProvider] = useState<AiProvider>('openrouter');
  const info = PROVIDER_INFO[provider];
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
          onChange={(e) => setProvider(e.target.value as AiProvider)}
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {AI_PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_INFO[p].label}
            </option>
          ))}
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="makeActive"
          defaultChecked={!hasKey}
          className="size-4"
        />
        Use this key for chat and the agents
      </label>
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
  provider: AiProvider;
  hint: string;
  active: boolean;
  canManage: boolean;
}) {
  const [useState_, useAction, using] = useActionState(setActiveAiKeyAction, undefined);
  const [removeState, removeAction, removing] = useActionState(removeAiKeyAction, undefined);
  const error = useState_?.error ?? removeState?.error;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{PROVIDER_INFO[provider].label}</p>
          <p className="text-sm text-muted-foreground">{hint}</p>
        </div>
        <div className="flex items-center gap-2">
          {active ? (
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
            <form action={removeAction}>
              <input type="hidden" name="provider" value={provider} />
              <Button type="submit" variant="outline" size="sm" disabled={removing}>
                {removing ? 'Removing…' : 'Remove'}
              </Button>
            </form>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
