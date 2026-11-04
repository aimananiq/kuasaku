'use client';

import { useState, useTransition } from 'react';
import { Megaphone } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  activateAdAction, approveAdAction, cancelJobAction, imageDecisionAction, pauseAdAction, scheduleActivationAction,
  type ActionResult,
} from '@/app/(app)/reach/meta-marketing-actions';

export type AdDraftView = {
  id: string; name: string; objective: string; status: string; adAccountId: string; pageName: string | null;
  budgetType: 'daily' | 'lifetime'; budgetMinor: number; currency: string; startsAt: string | null; endsAt: string | null;
  countries: string[]; ageMin?: number; ageMax?: number; headline: string | null; primaryText: string | null; description: string | null;
  cta: string | null; linkUrl: string | null; imageUrl: string | null; imageStatus: string; configHash: string | null;
  approvalExpiresAt: string | null; lastError: string | null; built: boolean;
};
export type JobView = { id: string; kind: string; runAt: string; status: string; lastError: string | null };

const money = (minor: number, currency: string) => new Intl.NumberFormat('en-MY', { style: 'currency', currency }).format(minor / 100);
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'Not set');
const LABEL: Record<string, string> = {
  draft: 'Draft', created_paused: 'Built · paused', approval_requested: 'Awaiting approval', approved: 'Approved', active: 'Active', paused: 'Paused', failed: 'Failed',
};

export function MetaAdsCard({ drafts, jobs, canManage, canApprove }: { drafts: AdDraftView[]; jobs: JobView[]; canManage: boolean; canApprove: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const run = (fn: () => Promise<ActionResult>) => start(async () => { const r = await fn(); setMessage(r.ok ? (r.message ?? 'Done.') : r.error); });

  return (
    <BentoCard title="Meta ad drafts" subtitle="Review before any money is spent" icon={Megaphone} className="col-span-2 md:col-span-6">
      <div className="grid gap-4">
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
        {drafts.length === 0 && <p className="text-sm text-muted-foreground">No ad drafts yet. Ask Jebat to prepare a Facebook ad campaign; it is created paused and shown here for your approval.</p>}
        {drafts.map((d) => (
          <article key={d.id} className="grid gap-3 rounded-lg border p-3 md:grid-cols-[160px_1fr]">
            <div>
              {d.imageUrl ? <img src={d.imageUrl} alt={`Ad image for ${d.name}`} className="aspect-square w-full rounded-md object-cover" /> : <div className="grid aspect-square place-items-center rounded-md bg-muted text-xs text-muted-foreground">No image</div>}
              <p className="mt-1 text-xs text-muted-foreground">Image: {d.imageStatus}</p>
            </div>
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2"><p className="font-medium">{d.name}</p><Badge variant={d.status === 'active' ? 'default' : 'secondary'}>{LABEL[d.status] ?? d.status}</Badge></div>
              <dl className="grid gap-1 text-sm">
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Ad account</dt><dd>{d.adAccountId}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Facebook Page</dt><dd>{d.pageName ?? 'Selected Page'}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Objective</dt><dd className="capitalize">{d.objective}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Audience</dt><dd>{d.countries.join(', ')}{d.ageMin || d.ageMax ? ` · ${d.ageMin ?? 18}–${d.ageMax ?? 65}` : ''}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Budget</dt><dd className="font-medium">{money(d.budgetMinor, d.currency)} {d.budgetType} ({d.currency})</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Schedule</dt><dd>{fmt(d.startsAt)} → {fmt(d.endsAt)}</dd></div>
                <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Destination</dt><dd className="truncate">{d.linkUrl ?? 'Lead form'}</dd></div>
              </dl>
              <div className="rounded-md bg-muted/50 p-2 text-sm">
                {d.headline && <p className="font-medium">{d.headline}</p>}
                {d.primaryText && <p>{d.primaryText}</p>}
                {d.description && <p className="text-muted-foreground">{d.description}</p>}
                {d.cta && <p className="mt-1 text-xs uppercase tracking-wide text-muted-foreground">{d.cta.replace('_', ' ')}</p>}
              </div>
              {d.lastError && <p className="text-sm text-destructive">{d.lastError}</p>}
              {d.approvalExpiresAt && d.status === 'approved' && <p className="text-xs text-muted-foreground">Approval expires {fmt(d.approvalExpiresAt)}.</p>}

              <div className="flex flex-wrap items-center gap-2">
                {canManage && d.imageUrl && d.imageStatus !== 'approved' && !d.built && <Button size="sm" disabled={pending} onClick={() => run(() => imageDecisionAction(d.id, 'approved'))}>Approve image</Button>}
                {canManage && d.imageUrl && !d.built && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => imageDecisionAction(d.id, 'rejected'))}>Reject &amp; regenerate</Button>}
                {canApprove && d.status === 'approval_requested' && d.configHash && <Button size="sm" disabled={pending} onClick={() => run(() => approveAdAction(d.id, d.configHash!))}>Approve {money(d.budgetMinor, d.currency)} {d.budgetType} budget</Button>}
                {canApprove && d.status === 'approved' && <Button size="sm" disabled={pending} onClick={() => run(() => activateAdAction(d.id))}>Activate now</Button>}
                {canManage && (d.status === 'active' || d.status === 'approved' || d.status === 'created_paused') && d.built && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => pauseAdAction(d.id))}>Pause</Button>}
              </div>
              {canApprove && d.status === 'approved' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="datetime-local" className="w-56" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Activation time (Malaysia time)" />
                  <Button size="sm" variant="outline" disabled={pending || !when} onClick={() => run(() => scheduleActivationAction(d.id, when, 'Asia/Kuala_Lumpur'))}>Schedule activation</Button>
                </div>
              )}
            </div>
          </article>
        ))}

        {jobs.length > 0 && (
          <div className="grid gap-1 text-sm">
            <p className="font-medium">Scheduled &amp; recent jobs</p>
            {jobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-1">
                <span>{j.kind.replace('_', ' ')} · {fmt(j.runAt)} · {j.status}{j.lastError ? ` · ${j.lastError}` : ''}</span>
                {canManage && j.status === 'pending' && <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelJobAction(j.id))}>Cancel</Button>}
              </div>
            ))}
          </div>
        )}
      </div>
    </BentoCard>
  );
}
