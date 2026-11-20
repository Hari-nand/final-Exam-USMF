-- ============================================================
-- Migration 006: notices from the database, and question reports.
-- Non-destructive. The app falls back gracefully if this has not been run.
-- ============================================================

-- Notices shown on everyone's Home page between show_from and show_until.
create table if not exists public.announcements (
  id          text primary key,
  title       text not null,
  intro       text,
  items       jsonb not null default '[]'::jsonb,   -- [[icon, title, text], ...]
  issuer      text not null default 'ANYMS',
  show_from   timestamptz not null default now(),
  show_until  timestamptz,
  created_at  timestamptz not null default now()
);
alter table public.announcements enable row level security;
drop policy if exists "users read live announcements" on public.announcements;
create policy "users read live announcements" on public.announcements
  for select to authenticated using (
    (show_from <= now() and (show_until is null or show_until > now()))
    or (select private.is_admin()));
drop policy if exists "admin manages announcements" on public.announcements;
create policy "admin manages announcements" on public.announcements
  for all to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
grant select, insert, update, delete on public.announcements to authenticated;
revoke all on public.announcements from anon;

-- A learner's report that something is wrong with a question.
create table if not exists public.question_reports (
  id           bigint generated always as identity primary key,
  question_id  bigint not null references public.questions (id) on delete cascade,
  user_id      uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  comment      text not null check (char_length(trim(comment)) between 3 and 1000),
  shown_order  int[],                 -- option order the learner saw (A = shown_order[1], ...)
  status       text not null default 'open' check (status in ('open', 'fixed', 'no_change')),
  admin_note   text check (admin_note is null or char_length(admin_note) <= 1000),
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references public.profiles (id) on delete set null
);
create index if not exists question_reports_status_idx on public.question_reports (status, created_at desc);
create index if not exists question_reports_question_idx on public.question_reports (question_id);
create index if not exists question_reports_user_idx on public.question_reports (user_id);
-- one open report per learner per question
create unique index if not exists question_reports_one_open on public.question_reports (question_id, user_id) where status = 'open';
alter table public.question_reports enable row level security;
drop policy if exists "users add own reports" on public.question_reports;
create policy "users add own reports" on public.question_reports
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'open' and admin_note is null and resolved_at is null and resolved_by is null
    and exists (select 1 from public.profiles where id = (select auth.uid()) and active));
drop policy if exists "users read own reports, admin reads all" on public.question_reports;
create policy "users read own reports, admin reads all" on public.question_reports
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "admin updates reports" on public.question_reports;
create policy "admin updates reports" on public.question_reports
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
drop policy if exists "admin deletes reports" on public.question_reports;
create policy "admin deletes reports" on public.question_reports
  for delete to authenticated using ((select private.is_admin()));
grant select, insert, update, delete on public.question_reports to authenticated;
revoke all on public.question_reports from anon;

-- Max 20 reports per learner per day, so the admin's list can't be flooded.
create or replace function private.limit_reports() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.question_reports
       where user_id = new.user_id and created_at > now() - interval '1 day') >= 20 then
    raise exception 'You have sent 20 reports today. Please try again tomorrow.';
  end if;
  return new;
end;
$$;
drop trigger if exists question_reports_limit on public.question_reports;
create trigger question_reports_limit before insert on public.question_reports
  for each row execute function private.limit_reports();

create index if not exists question_reports_resolved_by_idx on public.question_reports (resolved_by);
