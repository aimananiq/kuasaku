-- Workspace AI keys: media providers (fal.ai).
--
-- A workspace may now also save a key for a media provider (today: fal, which
-- makes images and video for the agents). It lives in org_ai_keys beside the chat
-- keys but is never the "active" key: chat and the agents' text keep running on the
-- one active chat key. So the three functions that pick or promote the active key
-- must skip media providers.
--
-- Only function bodies change (same names, arguments and results).

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
  media_providers constant text[] := array['fal'];
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
  if p_provider is null or p_provider !~ '^[a-z0-9_]{2,20}$' then
    raise exception 'invalid key';
  end if;
  if (p_ciphertext ~ '^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$') is not true
     or length(p_ciphertext) > 2000
     or (p_hint ~ '^[A-Za-z0-9_-]{2,8}…[A-Za-z0-9_-]{4}$') is not true then
    raise exception 'invalid key';
  end if;

  -- A media key is never the active (chat) key.
  if p_provider = any (media_providers) then
    make_active := false;
  else
    make_active := coalesce(p_make_active, false) or not exists (
      select 1 from public.org_ai_keys k
       where k.org_id = p_org and k.is_active and k.provider <> p_provider
    );
    if make_active then
      update public.org_ai_keys set is_active = false
       where org_id = p_org and provider <> p_provider and is_active;
    end if;
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

create or replace function public.set_active_org_ai_key(p_provider text)
returns void language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  org uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  org := private.current_org(uid);
  if org is null or not private.is_org_admin(org) then raise exception 'not allowed'; end if;
  -- A media key is not a chat key and cannot be chosen for chat.
  if p_provider = any (array['fal']) or not exists (
    select 1 from public.org_ai_keys where org_id = org and provider = p_provider
  ) then
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

  -- The oldest remaining CHAT key takes over; a media key never does.
  if was_active then
    update public.org_ai_keys set is_active = true
     where org_id = org
       and provider = (select k.provider from public.org_ai_keys k
                        where k.org_id = org and k.provider <> all (array['fal'])
                        order by k.updated_at limit 1);
  end if;

  insert into public.activity_log (org_id, actor_id, actor_name, action, target, category)
  values (org, uid, private.display_name(uid),
          'Removed the workspace AI key (' || p_provider || ')', null, 'security');
end; $$;

revoke all on function public.clear_org_ai_key(text) from public, anon;
grant execute on function public.clear_org_ai_key(text) to authenticated;
