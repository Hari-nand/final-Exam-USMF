-- ============================================================
-- Migration 005: security notice that every user accepts once
-- (shown again whenever the app raises the notice version).
-- Non-destructive.
-- ============================================================

alter table public.profiles add column if not exists notice_version int not null default 0;
alter table public.profiles add column if not exists notice_accepted_at timestamptz;

-- Proof of acceptance: who, which version, when, from where.
create table if not exists public.notice_acceptances (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  version      int not null,
  accepted_at  timestamptz not null default now(),
  device       text,
  ip           text,
  country      text
);
create index if not exists notice_acceptances_user_idx on public.notice_acceptances (user_id, accepted_at desc);
alter table public.notice_acceptances enable row level security;
create policy "admin reads notice acceptances" on public.notice_acceptances
  for select to authenticated using ((select private.is_admin()));

-- Record that the signed-in user accepted a version of the notice.
create or replace function public.accept_notice(p_version int, p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and active) then raise exception 'Account is not active'; end if;
  if p_version is null or p_version < 1 or p_version > 1000 then raise exception 'Invalid notice version'; end if;
  select * into o from private.request_origin();
  insert into public.notice_acceptances (user_id, version, device, ip, country)
  values (auth.uid(), p_version, left(nullif(trim(p_device), ''), 80), o.ip, o.country);
  update public.profiles set notice_version = greatest(notice_version, p_version), notice_accepted_at = now()
   where id = auth.uid();
end;
$$;

-- The current sign-in rules, so the notice can state them accurately.
create or replace function public.security_summary()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('one_device', one_device, 'idle_minutes', idle_minutes,
    'max_session_hours', max_session_hours, 'country_lock_hours', country_lock_hours)
  from public.security_settings
  where id and exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

grant select on public.notice_acceptances to authenticated;
revoke all on public.notice_acceptances from anon;
revoke execute on function public.accept_notice(int, text), public.security_summary() from public, anon;
grant execute on function public.accept_notice(int, text), public.security_summary() to authenticated;
