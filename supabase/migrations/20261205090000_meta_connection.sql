-- Meta Business connection (Jebat → Ad Settings → Connected account).
--
-- One row per workspace. The access token is sealed by the server (AES-256-GCM,
-- bound to the workspace and to the purpose 'org-meta-token') before it gets
-- here; the database never sees it in the clear and members can never read the
-- table: only the service role can. Members see a status through
-- meta_connection_status(), which carries no secret.
--
-- Also: short-lived OAuth state rows (CSRF), and an audit trail through the
-- existing activity_log.

create table public.org_meta_connections (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  method text not null check (method in ('oauth', 'system_user')),
  status text not null default 'connected'
    check (status in ('connected', 'permission_required', 'token_expired', 'error', 'disconnected')),
  ciphertext text not null check (length(ciphertext) <= 4000),
  token_type text,
  token_expires_at timestamptz,
  api_version text not null default 'v23.0',
  app_id text,
  business_id text,
  business_name text,
  ad_account_id text check (ad_account_id is null or ad_account_id ~ '^act_[0-9]{4,30}$'),
  ad_account_name text,
  page_id text check (page_id is null or page_id ~ '^[0-9]{4,30}$'),
  page_name text,
  granted_permissions text[] not null default '{}',
  last_validated_at timestamptz,
  last_error_code text,
  last_error_message text,
  connected_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.org_meta_connections enable row level security;
revoke all on public.org_meta_connections from anon, authenticated;
grant select, insert, update, delete on public.org_meta_connections to service_role;

-- OAuth state: single-use, 10 minutes, bound to the user and workspace that began it.
create table public.meta_oauth_states (
  state_hash text primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes',
  created_at timestamptz not null default now()
);
alter table public.meta_oauth_states enable row level security;
revoke all on public.meta_oauth_states from anon, authenticated;
grant select, insert, delete on public.meta_oauth_states to service_role;
create index meta_oauth_states_expires_idx on public.meta_oauth_states (expires_at);

-- What members may know: never the token.
create or replace function public.meta_connection_status()
returns table (
  method text, status text, business_id text, business_name text,
  ad_account_id text, ad_account_name text, page_id text, page_name text,
  granted_permissions text[], token_expires_at timestamptz,
  last_validated_at timestamptz, last_error_code text, last_error_message text
)
language sql security definer stable set search_path = public as $$
  select c.method, c.status, c.business_id, c.business_name, c.ad_account_id, c.ad_account_name,
         c.page_id, c.page_name, c.granted_permissions, c.token_expires_at,
         c.last_validated_at, c.last_error_code, c.last_error_message
  from public.org_meta_connections c
  where c.org_id = private.current_org(auth.uid());
$$;
revoke all on function public.meta_connection_status() from public, anon;
grant execute on function public.meta_connection_status() to authenticated;
