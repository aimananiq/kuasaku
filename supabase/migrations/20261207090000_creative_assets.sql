-- Durable images for Jebat and Kasturi: generated pictures are saved here instead of only linking to the
-- provider's temporary URL, so landing pages, forms, posts and ads keep working.
--
-- The bucket is public-read on purpose: its images appear on public landing pages and forms. Nothing in the API can
-- write to it (no storage policy below): only the server, with the service role, after it has checked the image.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('creative-assets', 'creative-assets', true, 10485760, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 10485760, allowed_mime_types = excluded.allowed_mime_types;

-- A banner picture for a lead form's public page. Kept beside `forms`, not in it, so the public form function and its
-- grants stay exactly as they are; the page reads it with the server's credential, only for a form that is open.
create table public.form_banners (
  form_id uuid primary key references public.forms(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  image_url text not null check (image_url ~ '^https://' and char_length(image_url) <= 600),
  created_at timestamptz not null default now()
);
alter table public.form_banners enable row level security;
create policy form_banners_select on public.form_banners for select to authenticated using (private.is_org_member(org_id));
create policy mfa_required on public.form_banners as restrictive for all to authenticated
  using ((select private.mfa_ok())) with check ((select private.mfa_ok()));
revoke all on public.form_banners from anon, authenticated;
grant select on public.form_banners to authenticated;
grant select, insert, update, delete on public.form_banners to service_role;
