-- Workspace AI keys: a workspace can hold one key per provider (OpenRouter,
-- OpenAI, Anthropic, Google, DeepSeek and others) and choose which one chat and the agents use.
--
-- Before: org_ai_keys had one row per workspace, always an OpenRouter key.
-- After:  one row per (workspace, provider). Exactly one row of a workspace is
--         `is_active`; chat and agents run on that one. Every existing row is an
--         OpenRouter key and becomes the active one, so nothing changes for a
--         workspace that already has a key.
--
-- Unchanged: the sealed value is still readable and writable by the server
-- only (service role); members still see only a hint (start + last 4 chars).

-- ---------------------------------------------------------------------------
-- 1. Table shape
-- ---------------------------------------------------------------------------
alter table public.org_ai_keys
  add column if not exists provider text not null default 'openrouter'
    check (provider ~ '^[a-z0-9_]{2,20}$'),
  add column if not exists is_active boolean not null default false;

update public.org_ai_keys set is_active = true;

alter table public.org_ai_keys drop constraint if exists org_ai_keys_pkey;
alter table public.org_ai_keys add primary key (org_id, provider);

create unique index if not exists org_ai_keys_one_active
  on public.org_ai_keys (org_id) where is_active;

-- ---------------------------------------------------------------------------
-- 2. Saving a key (service role only, as before, now with a provider)
-- ---------------------------------------------------------------------------
drop function if exists public.set_org_ai_key(uuid, uuid, text, text);

create or replace function public.set_org_ai_key(
  p_org uuid,
  p_actor uuid,
  p_provider text,
  p_ciphertext text,
  p_hint text,
  p_make_active boolean default false
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  make_active boolean;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception 'not allowed';
  end if;
  if p_org is null or p_actor is null or not exists (
    select 1 from public.org_members m
     where m.org_id = p_org and m.user_id = p_actor and m.role in ('owner', 'admin')
  ) then
    raise exception 'not allowed';
  end if;
  -- Which providers exist is the app's to decide; here only a plain name is required.
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,20}$' then
    raise exception 'invalid key';
  end if;
  -- v2.<12-byte iv>.<16-byte tag>.<ciphertext>, base64url parts (see
  -- 20261103110000_ai_key_format_check.sql for why the last part has no bound).
  if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true
     or length(p_ciphertext) > 2000
     or (p_hint ~ '^[A-Za-z0-9_-]{2,8}…[A-Za-z0-9_-]{4}$') is not true then
    raise exception 'invalid key';
  end if;

  -- The first key of a workspace is active; a later one only if asked, or if
  -- it replaces the active one.
  make_active := coalesce(p_make_active, false) or not exists (
    select 1 from public.org_ai_keys k
     where k.org_id = p_org and k.is_active and k.provider <> p_provider
  );
  if make_active then
    update public.org_ai_keys set is_active = false
     where org_id = p_org and provider <> p_provider and is_active;
  end if;

  insert into public.org_ai_keys (org_id, provider, ciphertext, key_hint, updated_by, updated_at, is_active)
  values (p_org, p_provider, p_ciphertext, p_hint, p_actor, now(), make_active)
  on conflict (org_id, provider) do update
    set ciphertext = excluded.ciphertext,
        key_hint = excluded.key_hint,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at,
        is_active = public.org_ai_keys.is_active or excluded.is_active;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (p_org, p_actor, private.display_name(p_actor),
          'Set the workspace AI key (' || p_provider || ')', p_hint, 'security');
end; $$;

revoke all on function public.set_org_ai_key(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.set_org_ai_key(uuid, uuid, text, text, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Choosing which key is used (owner/admin, as the caller)
-- ---------------------------------------------------------------------------
create or replace function public.set_active_org_ai_key(p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  org uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null or not private.is_org_admin(org) then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.org_ai_keys where org_id = org and provider = p_provider) then
    raise exception 'no such key';
  end if;

  update public.org_ai_keys set is_active = false
   where org_id = org and provider <> p_provider and is_active;
  update public.org_ai_keys set is_active = true
   where org_id = org and provider = p_provider;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (org, uid, private.display_name(uid), 'Chose the workspace AI key', p_provider, 'security');
end; $$;

revoke all on function public.set_active_org_ai_key(text) from public, anon;
grant execute on function public.set_active_org_ai_key(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Removing a key (owner/admin, as the caller). If it was the active one,
--    the oldest remaining key takes over, so a workspace that still has a key
--    never silently falls back to the free allowance.
-- ---------------------------------------------------------------------------
drop function if exists public.clear_org_ai_key();

create or replace function public.clear_org_ai_key(p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  org uuid;
  was_active boolean;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null or not private.is_org_admin(org) then raise exception 'not allowed'; end if;

  delete from public.org_ai_keys
   where org_id = org and provider = p_provider
   returning is_active into was_active;
  if not found then return; end if;

  if was_active then
    update public.org_ai_keys set is_active = true
     where org_id = org
       and provider = (select k.provider from public.org_ai_keys k
                        where k.org_id = org order by k.updated_at limit 1);
  end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (org, uid, private.display_name(uid),
          'Removed the workspace AI key (' || p_provider || ')', null, 'security');
end; $$;

revoke all on function public.clear_org_ai_key(text) from public, anon;
grant execute on function public.clear_org_ai_key(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. What members may know. `org_ai_key_status()` still answers "does the
--    workspace have a key, and what is its hint": now for the active key,
--    with its provider. `org_ai_keys_list()` lists every key's hint.
-- ---------------------------------------------------------------------------
drop function if exists public.org_ai_key_status();

create or replace function public.org_ai_key_status()
returns table (key_hint text, updated_at timestamptz, provider text)
language sql security definer stable set search_path = public as $$
  select k.key_hint, k.updated_at, k.provider
  from public.org_ai_keys k
  where k.org_id = private.current_org(auth.uid()) and k.is_active;
$$;

revoke all on function public.org_ai_key_status() from public, anon;
grant execute on function public.org_ai_key_status() to authenticated;

create or replace function public.org_ai_keys_list()
returns table (provider text, key_hint text, updated_at timestamptz, is_active boolean)
language sql security definer stable set search_path = public as $$
  select k.provider, k.key_hint, k.updated_at, k.is_active
  from public.org_ai_keys k
  where k.org_id = private.current_org(auth.uid())
  order by k.updated_at;
$$;

revoke all on function public.org_ai_keys_list() from public, anon;
grant execute on function public.org_ai_keys_list() to authenticated;
