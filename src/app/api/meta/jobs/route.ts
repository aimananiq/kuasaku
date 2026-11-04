import { NextResponse } from 'next/server';
import { isTriggerAuthorized } from '@/lib/agents/trigger-auth';
import { runDueJobs } from '@/lib/meta/marketing';
import { serviceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Scheduler tick (every minute): publishes due posts, runs approved activations and scheduled pauses. Cron-authed. */
export async function POST(req: Request) {
  if (!isTriggerAuthorized(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  return NextResponse.json({ ok: true, ...(await runDueJobs(serviceClient())) });
}
