-- ============================================================
-- Migration 010: admin replies to question reports + learner notifications.
--  * Reports get a new status 'in_review' (Under review) and a reply the
--    reporter can read (admin_reply). admin_note stays the admin's own note.
--  * Every time the admin replies or changes a report's status, the reporter
--    gets one notification. An unseen older one for the same report is replaced.
--  * Learners can only read their own notifications and mark them seen.
-- Works for reports that already exist. Non-destructive.
-- ============================================================

-- 1. Reports: new status and reply columns
alter table public.question_reports drop constraint if exists question_reports_status_check;
alter table public.question_reports add constraint question_reports_status_check
  check (status in ('open', 'in_review', 'fixed', 'no_change'));

alter table public.question_reports add column if not exists admin_reply text;
alter table public.question_reports add column if not exists replied_at timestamptz;
alter table public.question_reports drop constraint if exists question_reports_reply_len;
alter table public.question_reports add constraint question_reports_reply_len
  check (admin_reply is null or char_length(admin_reply) <= 1000);

-- One active report (new or under review) per learner per question
drop index if exists public.question_reports_one_open;
create unique index question_reports_one_open on public.question_reports (question_id, user_id)
  where status in ('open', 'in_review');

-- A learner's new report can never carry a reply
drop policy if exists "users add own reports" on public.question_reports;
create policy "users add own reports" on public.question_reports
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'open'
    and admin_note is null and resolved_at is null and resolved_by is null
    and admin_reply is null and replied_at is null
    and exists (select 1 from public.profiles where profiles.id = (select auth.uid()) and profiles.active));

-- Learners may read the reply on their own report; only admins (via RLS) may set it.
grant select (admin_reply, replied_at) on public.question_reports to authenticated;
grant update (admin_reply, replied_at) on public.question_reports to authenticated;

-- Keep timestamps honest whatever the client sends
create or replace function private.report_stamps() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.admin_reply is distinct from old.admin_reply then
    new.admin_reply := nullif(trim(new.admin_reply), '');
    new.replied_at  := case when new.admin_reply is null then null else now() end;
  end if;
  if new.status in ('fixed', 'no_change') then
    if old.status not in ('fixed', 'no_change') or new.resolved_at is null then new.resolved_at := now(); end if;
    new.resolved_by := coalesce(new.resolved_by, auth.uid());
  else
    new.resolved_at := null; new.resolved_by := null;
  end if;
  return new;
end $$;
drop trigger if exists question_reports_stamps on public.question_reports;
create trigger question_reports_stamps before update on public.question_reports
  for each row execute function private.report_stamps();

-- 2. Notifications
create table if not exists public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  kind        text not null default 'report_update' check (kind in ('report_update')),
  report_id   bigint references public.question_reports (id) on delete cascade,
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create index if not exists notifications_user_unseen_idx on public.notifications (user_id, created_at desc) where seen_at is null;
create index if not exists notifications_report_idx on public.notifications (report_id);

alter table public.notifications enable row level security;
drop policy if exists "users read own notifications, admin reads all" on public.notifications;
create policy "users read own notifications, admin reads all" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "users mark own notifications seen" on public.notifications;
create policy "users mark own notifications seen" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (seen_at) on public.notifications to authenticated;

-- 3. A reply or status change on a report notifies the person who sent it
create or replace function private.notify_report_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is distinct from auth.uid() then
    delete from public.notifications where report_id = new.id and seen_at is null;
    insert into public.notifications (user_id, kind, report_id) values (new.user_id, 'report_update', new.id);
  end if;
  return null;
end $$;
revoke all on function private.notify_report_update() from public, anon, authenticated;
drop trigger if exists question_reports_notify on public.question_reports;
create trigger question_reports_notify after update on public.question_reports
  for each row when (old.status is distinct from new.status or old.admin_reply is distinct from new.admin_reply)
  execute function private.notify_report_update();
