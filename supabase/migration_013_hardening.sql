-- Migration 013: security hardening, phase 1 (VAPT findings F6, F11, F14, F16, F17)
--  F6  size limits on learner-supplied arrays and on test size
--  F11 admin notes move to an admin-only table (learners could read them on their own reports)
--  F14 remove leftovers: old record_answer overload, one-off qbank function, unused pg_cron
--  F16 admin audit log (database side; the admin-users edge function writes its own rows)
--  F17 shorter retention: sign-in log 90 days; IP and country on notice acceptances cleared after 90 days

-- ---------------------------------------------------------------- F6
alter table public.question_reports drop constraint if exists question_reports_shown_order_size;
alter table public.question_reports add constraint question_reports_shown_order_size
  check (shown_order is null or cardinality(shown_order) <= 10);

alter table public.answers drop constraint if exists answers_selected_size;
alter table public.answers add constraint answers_selected_size
  check (selected is null or cardinality(selected) <= 10);

-- A test holds 1 to 5,000 questions (the whole bank is about 3,700).
alter table public.sessions drop constraint if exists sessions_total_range;
alter table public.sessions add constraint sessions_total_range check (total between 1 and 5000);

-- ---------------------------------------------------------------- F14
drop function if exists public.record_answer(bigint, integer);
drop function if exists private.apply_qbank_2026_11_20();
drop extension if exists pg_cron;

-- ---------------------------------------------------------------- F11
create table if not exists public.report_notes (
  report_id  bigint primary key references public.question_reports (id) on delete cascade,
  note       text not null check (char_length(note) between 1 and 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid() references public.profiles (id) on delete set null
);
alter table public.report_notes enable row level security;
drop policy if exists "admin manages report notes" on public.report_notes;
create policy "admin manages report notes" on public.report_notes
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
revoke all on public.report_notes from anon;
grant select, insert, update, delete on public.report_notes to authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'question_reports' and column_name = 'admin_note') then
    insert into public.report_notes (report_id, note, updated_at, updated_by)
    select id, admin_note, coalesce(resolved_at, created_at), resolved_by
      from public.question_reports
     where nullif(trim(admin_note), '') is not null
    on conflict (report_id) do nothing;
  end if;
end $$;

-- The learner insert rule mentions admin_note, so rebuild it before the column goes.
drop policy if exists "users add own reports" on public.question_reports;
create policy "users add own reports" on public.question_reports
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'open'
    and resolved_at is null and resolved_by is null
    and admin_reply is null and replied_at is null
    and exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.active));
alter table public.question_reports drop column if exists admin_note;

-- ---------------------------------------------------------------- F16
create table if not exists public.admin_audit (
  id      bigint generated always as identity primary key,
  at      timestamptz not null default now(),
  actor   uuid,                 -- who did it (null = system / service key without a named admin)
  action  text not null check (char_length(action) <= 60),
  target  text check (char_length(target) <= 200),
  detail  jsonb check (detail is null or octet_length(detail::text) <= 4000)
);
create index if not exists admin_audit_at_idx on public.admin_audit (at desc);
alter table public.admin_audit enable row level security;
drop policy if exists "admin reads audit log" on public.admin_audit;
create policy "admin reads audit log" on public.admin_audit
  for select to authenticated using ((select private.is_admin()));
revoke all on public.admin_audit from anon, authenticated;
grant select on public.admin_audit to authenticated;

create or replace function private.audit(p_action text, p_target text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.admin_audit (actor, action, target, detail) values (auth.uid(), p_action, p_target, p_detail);
$$;
revoke all on function private.audit(text, text, jsonb) from public, anon, authenticated;

create or replace function private.audit_profiles() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    perform private.audit('account.role', new.id::text, jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  if new.active is distinct from old.active then
    perform private.audit(case when new.active then 'account.enable' else 'account.disable' end, new.id::text, null);
  end if;
  return null;
end $$;
drop trigger if exists audit_profiles on public.profiles;
create trigger audit_profiles after update on public.profiles
  for each row execute function private.audit_profiles();

create or replace function private.audit_allowlist() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Changes made by the admin-users edge function (secret key, no signed-in user) are logged by the function itself.
  if auth.uid() is null then return null; end if;
  if tg_op = 'INSERT' then
    perform private.audit('allowlist.add', new.email, jsonb_build_object('role', new.role));
  elsif tg_op = 'DELETE' then
    perform private.audit('allowlist.remove', old.email, jsonb_build_object('role', old.role));
  elsif new.role is distinct from old.role or new.email is distinct from old.email then
    perform private.audit('allowlist.change', new.email, jsonb_build_object('from', old.role, 'to', new.role));
  end if;
  return null;
end $$;
drop trigger if exists audit_allowlist on public.allowed_users;
create trigger audit_allowlist after insert or update or delete on public.allowed_users
  for each row execute function private.audit_allowlist();

create or replace function private.audit_security() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_diff jsonb;
begin
  select jsonb_object_agg(n.key, jsonb_build_object('from', o.value, 'to', n.value)) into v_diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
   where n.value is distinct from o.value;
  if v_diff is not null then perform private.audit('security.settings', null, v_diff); end if;
  return null;
end $$;
drop trigger if exists audit_security on public.security_settings;
create trigger audit_security after update on public.security_settings
  for each row execute function private.audit_security();

create or replace function private.audit_notices() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform private.audit('notice.publish', new.id, jsonb_build_object('title', left(new.title, 120)));
  else
    perform private.audit('notice.delete', old.id, jsonb_build_object('title', left(old.title, 120)));
  end if;
  return null;
end $$;
drop trigger if exists audit_notices on public.announcements;
create trigger audit_notices after insert or delete on public.announcements
  for each row execute function private.audit_notices();

create or replace function private.audit_signouts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.audit('account.sign_out', new.user_id::text, jsonb_build_object('detail', new.detail));
  return null;
end $$;
drop trigger if exists audit_signouts on public.login_events;
create trigger audit_signouts after insert on public.login_events
  for each row when (new.event = 'admin_signout') execute function private.audit_signouts();

-- ---------------------------------------------------------------- F17
-- Runs after every sign-in event, so old rows go even for learners who never sign in again.
create or replace function private.retention_sweep() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.login_events where at < now() - interval '90 days';
  update public.notice_acceptances set ip = null, country = null
   where accepted_at < now() - interval '90 days' and (ip is not null or country is not null);
  return null;
end $$;
drop trigger if exists retention_sweep on public.login_events;
create trigger retention_sweep after insert on public.login_events
  for each statement execute function private.retention_sweep();

revoke all on function private.audit_profiles(), private.audit_allowlist(), private.audit_security(),
  private.audit_notices(), private.audit_signouts(), private.retention_sweep() from public, anon, authenticated;
