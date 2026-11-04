'use client';

import { useEffect, useState, useTransition } from 'react';
import { Megaphone, Plug } from 'lucide-react';
import { BentoCard } from '@/components/bento/bento';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { MetaPublicStatus } from '@/lib/meta/connection';
import {
  disconnectMetaAction, listMetaAssetsAction, saveSystemUserAction, selectMetaAssetAction, testMetaConnectionAction,
  type MetaAssets,
} from '@/app/(app)/reach/meta-actions';

const BADGE: Record<MetaPublicStatus['status'], { label: string; variant: 'secondary' | 'default' | 'destructive' | 'outline' }> = {
  not_connected: { label: 'Not connected', variant: 'secondary' },
  connected: { label: 'Connected', variant: 'default' },
  permission_required: { label: 'Permission required', variant: 'outline' },
  token_expired: { label: 'Token expired', variant: 'destructive' },
  error: { label: 'Connection error', variant: 'destructive' },
  disconnected: { label: 'Not connected', variant: 'secondary' },
};

const FLASH: Record<string, string> = {
  connected: 'Meta connected. Choose your ad account and Page below.',
  denied: 'Meta access was not granted.',
  invalid: 'That connection attempt expired or did not match. Please try again.',
  error: 'Meta could not complete the connection. Please try again.',
  forbidden: 'Only an owner or admin can connect Meta.',
  not_configured: 'Meta is not configured on this server yet (META_APP_ID and META_APP_SECRET).',
};

export function MetaConnectionCard({ status, canManage, oauthReady }: { status: MetaPublicStatus; canManage: boolean; oauthReady: boolean }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [assets, setAssets] = useState<MetaAssets | null>(null);
  const [showSystemUser, setShowSystemUser] = useState(status.status === 'not_connected');
  const badge = BADGE[status.status];
  const needsReconnect = status.status === 'token_expired' || status.status === 'permission_required' || status.status === 'error';

  // The OAuth callback redirects back with ?meta=<outcome>; this screen's route file is generated, so read it here.
  useEffect(() => {
    const flash = new URLSearchParams(window.location.search).get('meta');
    if (flash && FLASH[flash]) setMessage(FLASH[flash]);
  }, []);

  useEffect(() => {
    if (!status.connected || !canManage) return;
    listMetaAssetsAction().then((r) => r.ok && setAssets(r.assets));
  }, [status.connected, canManage]);

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMessage(r.ok ? (r.message ?? null) : (r.error ?? 'Something went wrong.'));
    });

  const picker = (label: string, kind: 'business' | 'adAccount' | 'page', current: string | null, items: { id: string; name: string }[] | undefined) => (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      <Select disabled={!canManage || pending || !items?.length} value={current ?? undefined} onValueChange={(id) => run(() => selectMetaAssetAction(kind, id))}>
        <SelectTrigger><SelectValue placeholder={items ? (items.length ? `Select ${label.toLowerCase()}` : 'None available') : 'Loading…'} /></SelectTrigger>
        <SelectContent>{items?.map((i) => <SelectItem key={i.id} value={i.id}>{i.name}</SelectItem>)}</SelectContent>
      </Select>
    </div>
  );

  return (
    <BentoCard title="Connected account" subtitle="Link Meta to run and sync ads" icon={Plug} className="col-span-2 md:col-span-6">
      <div className="grid gap-4">
        <div className="flex items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Megaphone className="size-5" /></div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">Meta Business</p>
              <Badge variant={badge.variant}>{badge.label}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {status.connected ? (status.businessName ?? 'Business not selected') : status.lastError ?? 'Connect to publish to your Page and prepare ads.'}
            </p>
          </div>
        </div>

        {status.status !== 'not_connected' && (
          <dl className="grid gap-1 text-sm">
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Ad account</dt><dd>{status.adAccountName ?? 'Not selected'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Facebook Page</dt><dd>{status.pageName ?? 'Not selected'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Last verified</dt><dd>{status.lastValidatedAt ? new Date(status.lastValidatedAt).toLocaleString() : 'Never'}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Permissions</dt><dd className="text-right">{status.permissions.length ? status.permissions.join(', ') : 'None granted'}</dd></div>
          </dl>
        )}

        {status.connected && canManage && (
          <div className="grid gap-3 md:grid-cols-3">
            {picker('Business', 'business', null, assets?.businesses)}
            {picker('Ad account', 'adAccount', status.adAccountId, assets?.adAccounts)}
            {picker('Page', 'page', status.pageId, assets?.pages)}
          </div>
        )}

        {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            {oauthReady ? (
              <Button asChild size="sm"><a href="/api/meta/oauth/start">{status.status === 'not_connected' ? 'Connect Meta' : needsReconnect ? 'Reconnect' : 'Reconnect'}</a></Button>
            ) : (
              <p className="text-xs text-muted-foreground">One-click Facebook login is off until META_APP_ID and META_APP_SECRET are set on the server. You can connect now with a system user token below.</p>
            )}
            {status.status !== 'not_connected' && <Button size="sm" variant="outline" disabled={pending} onClick={() => run(testMetaConnectionAction)}>Test connection</Button>}
            <Button size="sm" variant="ghost" onClick={() => setShowSystemUser((v) => !v)}>{showSystemUser ? 'Hide token form' : 'Use a system user token'}</Button>
            {status.status !== 'not_connected' && <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(disconnectMetaAction)}>Disconnect</Button>}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only an owner or admin can change the Meta connection.</p>
        )}

        {showSystemUser && canManage && (
          <form className="grid gap-3 rounded-lg border p-3 md:grid-cols-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run(() => saveSystemUserAction(f)); }} autoComplete="off">
            <div className="grid gap-1.5 md:col-span-2"><Label htmlFor="meta-token">System user access token</Label><Input id="meta-token" name="token" type="password" autoComplete="off" required /></div>
            <div className="grid gap-1.5"><Label htmlFor="meta-app">App ID</Label><Input id="meta-app" name="appId" inputMode="numeric" /></div>
            <div className="grid gap-1.5"><Label htmlFor="meta-biz">Business Portfolio ID</Label><Input id="meta-biz" name="businessId" inputMode="numeric" /></div>
            <div className="grid gap-1.5"><Label htmlFor="meta-act">Ad Account ID</Label><Input id="meta-act" name="adAccountId" placeholder="act_1234567890" /></div>
            <div className="grid gap-1.5"><Label htmlFor="meta-page">Facebook Page ID</Label><Input id="meta-page" name="pageId" inputMode="numeric" /></div>
            <p className="text-xs text-muted-foreground md:col-span-2">The token is checked against Meta and each asset before it is saved, then stored encrypted. It is never shown again.</p>
            <div className="md:col-span-2"><Button type="submit" size="sm" disabled={pending}>Verify &amp; save</Button></div>
          </form>
        )}
      </div>
    </BentoCard>
  );
}
