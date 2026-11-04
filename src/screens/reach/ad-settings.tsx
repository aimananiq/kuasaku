import {
  AlertTriangle,
  CircleCheck,
  HeartPulse,
  Megaphone,
  Plug,
  XCircle,
} from 'lucide-react';
import { ScreenContainer } from '@/components/screen/screen-container';
import { PageHeader } from '@/components/screen/page-header';
import { BentoGrid, BentoCard } from '@/components/bento/bento';
import { RadialGauge } from '@/components/charts';
import { Badge } from '@/components/ui/badge';
import { MetaConnectionCard } from '@/components/reach/meta-connection-card';
import { MetaPostsCard, type PostView } from '@/components/reach/meta-posts-card';
import { MetaAdsCard, type AdDraftView, type JobView } from '@/components/reach/meta-ads-card';
import { NOT_CONNECTED, publicStatus } from '@/lib/meta/connection';
import { createClient } from '@/lib/supabase/server';
import { AdSettingsForm } from '@/components/reach/ad-settings-form';
import { WorkspaceCard } from '@/components/settings/workspace-card';
import { loadWorkspaceOverview } from '@/lib/account/workspace-overview';
import { getViewer } from '@/lib/auth/viewer';
import { can } from '@/lib/auth/permissions';
import { cn } from '@/lib/utils';
import { loadReachData } from './parts';

type Status = 'Healthy' | 'Warning' | 'Action needed';

type Check = {
  name: string;
  description: string;
  status: Status;
};

const CHECKS: Check[] = [
  {
    name: 'Meta account connected',
    description: 'Link your Meta Business account',
    status: 'Action needed',
  },
  {
    name: 'Facebook Page linked',
    description: 'Select the Page to run ads from',
    status: 'Action needed',
  },
  {
    name: 'Lead forms configured',
    description: 'At least one active lead form',
    status: 'Warning',
  },
  {
    name: 'WhatsApp number verified',
    description: 'For auto follow-ups',
    status: 'Healthy',
  },
  {
    name: 'Billing method on file',
    description: 'Meta bills your card directly',
    status: 'Healthy',
  },
  {
    name: 'Conversions API / Pixel',
    description: 'Improves tracking accuracy',
    status: 'Warning',
  },
  {
    name: 'Domain verified',
    description: 'Required for some objectives',
    status: 'Healthy',
  },
];

const STATUS_PILL: Record<Status, string> = {
  Healthy: 'bg-emerald-500/15 text-emerald-600',
  Warning: 'bg-amber-500/15 text-amber-600',
  'Action needed': 'bg-red-500/15 text-red-600',
};

function StatusIcon({ status }: { status: Status }) {
  if (status === 'Healthy') {
    return <CircleCheck className="size-5 shrink-0 text-emerald-600" />;
  }
  if (status === 'Warning') {
    return <AlertTriangle className="size-5 shrink-0 text-amber-600" />;
  }
  return <XCircle className="size-5 shrink-0 text-red-600" />;
}

export default async function AdSettingsScreen() {
  const [data, viewer, workspace] = await Promise.all([loadReachData(), getViewer(), loadWorkspaceOverview()]);
  const settings = await data.getAdSettings();
  const metaStatus = viewer.isDemo ? NOT_CONNECTED : await publicStatus(await createClient());
  const session = viewer.isDemo ? null : await createClient();
  const [draftRows, jobRows, postRows] = session
    ? await Promise.all([
        session.from('meta_ad_drafts').select('*').order('created_at', { ascending: false }).limit(10),
        session.from('meta_jobs').select('id,kind,run_at,status,last_error').order('run_at', { ascending: false }).limit(10),
        session.from('meta_page_posts').select('id,message,link,media_urls,status,scheduled_at,published_at,last_error').order('created_at', { ascending: false }).limit(10),
      ])
    : [{ data: [] }, { data: [] }, { data: [] }];
  const drafts: AdDraftView[] = ((draftRows.data ?? []) as Record<string, any>[]).map((d) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: d.id, name: d.name, objective: d.objective, status: d.status, adAccountId: d.ad_account_id, pageName: metaStatus.pageName, budgetType: d.budget_type,
    budgetMinor: Number(d.budget_minor), currency: d.currency, startsAt: d.starts_at, endsAt: d.ends_at, countries: d.targeting?.countries ?? [],
    ageMin: d.targeting?.ageMin, ageMax: d.targeting?.ageMax, headline: d.headline, primaryText: d.primary_text, description: d.description, cta: d.cta,
    linkUrl: d.link_url, imageUrl: d.image_url, imageStatus: d.image_status, configHash: d.config_hash, approvalExpiresAt: d.approval_expires_at,
    lastError: d.last_error, built: Boolean(d.meta_ad_id),
  }));
  const jobs: JobView[] = ((jobRows.data ?? []) as Record<string, any>[]).map((j) => ({ id: j.id, kind: j.kind, runAt: j.run_at, status: j.status, lastError: j.last_error })); // eslint-disable-line @typescript-eslint/no-explicit-any
  const posts: PostView[] = ((postRows.data ?? []) as Record<string, any>[]).map((p) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
    id: p.id, message: p.message, link: p.link, mediaUrls: p.media_urls ?? [], status: p.status, scheduledAt: p.scheduled_at, publishedAt: p.published_at, lastError: p.last_error,
  }));
  const canEdit = !viewer.isDemo && can(viewer.role, 'edit-data');
  const issues = CHECKS.filter((c) => c.status === 'Action needed').length;

  return (
    <ScreenContainer>
      <PageHeader
        className="mb-4"
        title="Ad Settings"
        subtitle="Your ad account, budgets and automation."
      />

      <BentoGrid>
        <WorkspaceCard overview={workspace} />

        {/* Connected account */}
        <MetaConnectionCard
          status={metaStatus}
          canManage={!viewer.isDemo && can(viewer.role, 'manage-ads-account')}
          oauthReady={Boolean(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim())}
        />

        {metaStatus.connected && <MetaPostsCard posts={posts} canManage={!viewer.isDemo && can(viewer.role, 'manage-ads-account')} />}

        {metaStatus.connected && (
          <MetaAdsCard
            drafts={drafts}
            jobs={jobs}
            canManage={!viewer.isDemo && can(viewer.role, 'manage-ads-account')}
            canApprove={!viewer.isDemo && can(viewer.role, 'approve-ad-spend')}
          />
        )}

        <AdSettingsForm settings={settings} canEdit={canEdit} />

        {/* Health check (absorbed) */}
        <BentoCard
          title="Health check"
          subtitle="Setup checklist for your ad engine"
          icon={HeartPulse}
          className="col-span-2 md:col-span-12"
        >
          {viewer.isDemo ? (
            <div className="grid gap-4 md:grid-cols-12">
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border bg-background/50 p-4 md:col-span-4">
                <RadialGauge value={71} label="healthy" valueLabel="71%" height={200} />
                <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                  <AlertTriangle className="size-4 shrink-0 text-amber-600" />
                  <p className="text-sm font-medium">
                    {issues} issue{issues === 1 ? '' : 's'} need attention
                  </p>
                </div>
              </div>
              <div className="divide-y rounded-lg border bg-background/50 md:col-span-8">
                {CHECKS.map((check) => (
                  <div
                    key={check.name}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <StatusIcon status={check.status} />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{check.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {check.description}
                        </p>
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
                        STATUS_PILL[check.status],
                      )}
                    >
                      {check.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="grid min-h-24 place-items-center text-center text-sm text-muted-foreground">
              Coming soon
            </p>
          )}
        </BentoCard>
      </BentoGrid>

    </ScreenContainer>
  );
}
