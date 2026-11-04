import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { AiKeyForm, SavedAiKeyRow } from '@/components/account/ai-key-form';
import { isKeyProvider, type KeyProvider } from '@/lib/ai/providers';
import { ReadOnlyNotice } from '@/components/account/settings-form';
import { getChatStatus } from '@/lib/ai/gate';
import { hasKeySecret } from '@/lib/ai/key-crypto';
import { WORKSPACE_KEY_TURNS_PER_DAY } from '@/lib/ai/rate-limit';
import { can } from '@/lib/auth/permissions';
import { getViewer, hasSupabaseEnv } from '@/lib/auth/viewer';
import { createClient } from '@/lib/supabase/server';

export default async function AiKeyPage() {
  const viewer = await getViewer();
  const live = hasSupabaseEnv() && !viewer.isDemo;
  const status = live ? await getChatStatus(await createClient()) : null;
  const canManage = live && can(viewer.role, 'manage-ai-key');
  const { data: keyRows } = live
    ? await (await createClient()).rpc('org_ai_keys_list')
    : { data: null };
  const savedKeys = ((keyRows ?? []) as {
    provider: string;
    key_hint: string;
    is_active: boolean;
  }[]).flatMap((r) =>
    isKeyProvider(r.provider)
      ? [{ provider: r.provider as KeyProvider, hint: r.key_hint, active: r.is_active }]
      : [],
  );

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">AI key</h1>
        <p className="text-sm text-muted-foreground">
          Chat and the agents run on your own AI account.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>How it works</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>
              Add a key for {viewer.orgName} from OpenRouter, OpenAI,
              Anthropic (Claude), Google (Gemini), DeepSeek, xAI (Grok),
              Mistral, Groq, Together AI, Moonshot (Kimi) or Alibaba Qwen, and everyone in the workspace
              chats on it, billed to your account with that provider. You can
              save a key for each provider and choose which one is in use. Set a
              spending limit on the key with the provider.
            </p>
            <p>
              {`As a safety net, each person can send up to ${WORKSPACE_KEY_TURNS_PER_DAY} chat requests a day on the key.`}{' '}
              The count resets at midnight UTC (8 am Malaysia time).
            </p>
            <p>
              Without a key, each person gets{' '}
              {status?.freeLimit ?? 3} free questions a week across all the
              assistants.
            </p>
            <p>
              Reading receipts uses OpenRouter, so it needs an OpenRouter key in
              use. The agents&apos; images and video are made on fal.ai when you
              add a fal.ai key (it is saved beside the others and never used for
              chat), otherwise on OpenRouter.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace key</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {!status ? (
              <ReadOnlyNotice>
                The demo workspace shows sample answers and does not use a key.
                Sign up to add your own.
              </ReadOnlyNotice>
            ) : (
              <>
                {savedKeys.length > 0 ? (
                  <div className="space-y-4">
                    {savedKeys.map((k) => (
                      <SavedAiKeyRow
                        key={k.provider}
                        provider={k.provider}
                        hint={k.hint}
                        active={k.active}
                        canManage={canManage}
                      />
                    ))}
                  </div>
                ) : (
                  <div>
                    <p className="font-medium">No key added</p>
                    <p className="text-sm text-muted-foreground">
                      {`You have ${status.freeRemaining} of ${status.freeLimit} free questions left this week.`}
                    </p>
                  </div>
                )}

                {!canManage ? (
                  <ReadOnlyNotice>
                    Only owners and admins can add or change the workspace key.
                  </ReadOnlyNotice>
                ) : !hasKeySecret() ? (
                  <ReadOnlyNotice>
                    This server is not set up to store workspace keys yet. The
                    host needs AI_KEYS_ENCRYPTION_SECRET set.
                  </ReadOnlyNotice>
                ) : (
                  <>
                    <div className="border-t pt-5">
                      <p className="mb-3 text-sm font-medium">
                        {status.hasKey ? 'Add or replace a key' : 'Add a key'}
                      </p>
                      <AiKeyForm hasKey={status.hasKey} />
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
