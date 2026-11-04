-- Meta marketing: Page posts, paid-ad drafts (Campaign → Ad Set → Creative → Ad), the persistent job queue,
-- and Lead Ads ingestion bookkeeping. All server-written: members read through RLS, only the service role writes.

-- ---------------------------------------------------------------- organic Page posts
create table public.meta_page_posts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  page_id text not null check (page_id ~ '^[0-9]{4,30}$'),
  kind text not null check (kind in ('text', 'link', 'image', 'multi_image')),
  message text,
  link text,
  media_urls text[] not null default '{}',
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  scheduled_at timestamptz,
  timezone text not null default 'Asia/Kuala_Lumpur',
  published_at timestamptz,
  fb_post_id text,
  attempts int not null default 0,
  last_error text,
  api_response jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (message is not null or link is not null or cardinality(media_urls) > 0)
);
alter table public.meta_page_posts enable row level security;
create policy meta_page_posts_select on public.meta_page_posts for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.meta_page_posts as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.meta_page_posts from anon, authenticated;
grant select on public.meta_page_posts to authenticated;
grant select, insert, update, delete on public.meta_page_posts to service_role;
create index meta_page_posts_org_idx on public.meta_page_posts (org_id, created_at desc);
-- A Facebook post id can be recorded once: a retry that already published can never record a second post.
create unique index meta_page_posts_fb_unique on public.meta_page_posts (org_id, fb_post_id) where fb_post_id is not null;

-- ---------------------------------------------------------------- paid ad drafts
create table public.meta_ad_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  ad_account_id text not null check (ad_account_id ~ '^act_[0-9]{4,30}$'),
  page_id text not null check (page_id ~ '^[0-9]{4,30}$'),
  objective text not null check (objective in ('awareness', 'traffic', 'engagement', 'leads', 'sales')),
  budget_type text not null check (budget_type in ('daily', 'lifetime')),
  budget_minor bigint not null check (budget_minor > 0),
  currency text not null check (char_length(currency) = 3),
  starts_at timestamptz,
  ends_at timestamptz,
  timezone text not null default 'Asia/Kuala_Lumpur',
  targeting jsonb not null default '{}'::jsonb,
  placements text[] not null default '{}',
  optimization_goal text,
  bid_strategy text,
  headline text,
  primary_text text,
  description text,
  cta text,
  link_url text,
  lead_form_id text,
  image_url text,
  image_status text not null default 'pending' check (image_status in ('pending', 'approved', 'rejected')),
  image_hash text,
  meta_campaign_id text,
  meta_adset_id text,
  meta_creative_id text,
  meta_ad_id text,
  status text not null default 'draft'
    check (status in ('draft', 'created_paused', 'approval_requested', 'approved', 'active', 'paused', 'failed')),
  -- Hash of every material setting. Approval is bound to it: change a setting and the approval no longer matches.
  config_hash text,
  approval_requested_by uuid references auth.users(id) on delete set null,
  approval_requested_at timestamptz,
  approved_by uuid references auth.users(id) on delete set null,
  approved_hash text,
  approved_at timestamptz,
  approval_expires_at timestamptz,
  activated_at timestamptz,
  last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.meta_ad_drafts enable row level security;
create policy meta_ad_drafts_select on public.meta_ad_drafts for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.meta_ad_drafts as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.meta_ad_drafts from anon, authenticated;
grant select on public.meta_ad_drafts to authenticated;
grant select, insert, update, delete on public.meta_ad_drafts to service_role;
create index meta_ad_drafts_org_idx on public.meta_ad_drafts (org_id, created_at desc);

-- ---------------------------------------------------------------- persistent job queue
create table public.meta_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('publish_post', 'activate_ad', 'pause_ad')),
  target_id uuid not null,
  run_at timestamptz not null,
  timezone text not null default 'Asia/Kuala_Lumpur',
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  locked_at timestamptz,
  last_error text,
  -- One job per (kind, target, run time): scheduling twice cannot publish twice.
  idempotency_key text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.meta_jobs enable row level security;
create policy meta_jobs_select on public.meta_jobs for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.meta_jobs as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.meta_jobs from anon, authenticated;
grant select on public.meta_jobs to authenticated;
grant select, insert, update, delete on public.meta_jobs to service_role;
create unique index meta_jobs_idem on public.meta_jobs (idempotency_key);
create index meta_jobs_due_idx on public.meta_jobs (run_at) where status in ('pending', 'running');

-- Claims due jobs atomically. A 'running' job whose lock is older than 10 minutes (a crashed worker) is claimable again.
create or replace function public.meta_claim_jobs(p_limit int default 10)
returns setof public.meta_jobs
language sql security definer set search_path = public as $$
  update public.meta_jobs j
     set status = 'running', locked_at = now(), attempts = j.attempts + 1, updated_at = now()
   where j.id in (
     select id from public.meta_jobs
      where run_at <= now()
        and (status = 'pending' or (status = 'running' and locked_at < now() - interval '10 minutes'))
        and attempts < max_attempts
      order by run_at
      limit least(greatest(p_limit, 1), 50)
      for update skip locked)
  returning j.*;
$$;
revoke all on function public.meta_claim_jobs(int) from public, anon, authenticated;
grant execute on function public.meta_claim_jobs(int) to service_role;

-- ---------------------------------------------------------------- Lead Ads → Kasturi
-- One row per Meta lead id: a repeated webhook delivery finds it and stops. Holds no personal data.
create table public.meta_lead_ingest (
  org_id uuid not null references public.orgs(id) on delete cascade,
  leadgen_id text not null,
  form_id text,
  ad_id text,
  campaign_id text,
  contact_id uuid,
  created_at timestamptz not null default now(),
  primary key (org_id, leadgen_id)
);
alter table public.meta_lead_ingest enable row level security;
create policy meta_lead_ingest_select on public.meta_lead_ingest for select to authenticated using (private.is_org_member(org_id));
revoke all on public.meta_lead_ingest from anon, authenticated;
grant select on public.meta_lead_ingest to authenticated;
grant select, insert, update, delete on public.meta_lead_ingest to service_role;

-- Maps a Page to the workspace that connected it, for webhook routing, without exposing the token table.
create or replace function public.meta_org_for_page(p_page_id text)
returns uuid language sql security definer stable set search_path = public as $$
  select org_id from public.org_meta_connections where page_id = p_page_id and status = 'connected' limit 1;
$$;
revoke all on function public.meta_org_for_page(text) from public, anon, authenticated;
grant execute on function public.meta_org_for_page(text) to service_role;
