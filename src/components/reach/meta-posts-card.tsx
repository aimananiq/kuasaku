'use client';

import { useState, useTransition } from 'react';
import { Send } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cancelPostAction, publishPostAction, schedulePostAction, type ActionResult } from '@/app/(app)/reach/meta-marketing-actions';

export type PostView = { id: string; message: string | null; link: string | null; mediaUrls: string[]; status: string; scheduledAt: string | null; publishedAt: string | null; lastError: string | null };

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

export function MetaPostsCard({ posts, canManage }: { posts: PostView[]; canManage: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const run = (fn: () => Promise<ActionResult>) => start(async () => { const r = await fn(); setConfirming(null); setMessage(r.ok ? (r.message ?? 'Done.') : r.error); });

  return (
    <BentoCard title="Facebook post drafts" subtitle="Nothing goes on your Page until you publish it" icon={Send} className="col-span-2 md:col-span-6">
      <div className="grid gap-3">
        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
        {posts.length === 0 && <p className="text-sm text-muted-foreground">No posts yet. Weekly Studio and Jebat save drafts here for you to publish or schedule.</p>}
        {posts.map((p) => (
          <article key={p.id} className="grid gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={p.status === 'published' ? 'default' : 'secondary'} className="capitalize">{p.status}</Badge>
              {p.scheduledAt && p.status === 'scheduled' && <span className="text-xs text-muted-foreground">Publishes {fmt(p.scheduledAt)}</span>}
              {p.publishedAt && <span className="text-xs text-muted-foreground">Published {fmt(p.publishedAt)}</span>}
            </div>
            {p.message && <p className="whitespace-pre-wrap text-sm">{p.message}</p>}
            {p.link && <p className="truncate text-sm text-muted-foreground">{p.link}</p>}
            {p.mediaUrls.length > 0 && <p className="text-xs text-muted-foreground">{p.mediaUrls.length} image(s) attached</p>}
            {p.lastError && <p className="text-sm text-destructive">{p.lastError}</p>}
            {canManage && (p.status === 'draft' || p.status === 'scheduled') && (
              <div className="flex flex-wrap items-center gap-2">
                {confirming === p.id ? (
                  <>
                    <span className="text-sm">Post this publicly on your Page now?</span>
                    <Button size="sm" disabled={pending} onClick={() => run(() => publishPostAction(p.id))}>Yes, publish</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>Back</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" disabled={pending} onClick={() => setConfirming(p.id)}>Publish now</Button>
                    <Input type="datetime-local" className="w-56" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Publish time (Malaysia time)" />
                    <Button size="sm" variant="outline" disabled={pending || !when} onClick={() => run(() => schedulePostAction(p.id, when, 'Asia/Kuala_Lumpur'))}>Schedule</Button>
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelPostAction(p.id))}>Discard</Button>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </BentoCard>
  );
}
