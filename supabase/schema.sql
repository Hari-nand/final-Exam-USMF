-- ============================================================
-- MCQ Practice app: database setup
-- Safe to re-run. Already applied to the live project.
-- The first admin's email is set in section 7 at the bottom.
-- ============================================================

-- 1. Tables ---------------------------------------------------

-- Emails the admin has approved. Only these can get an account.
create table if not exists public.allowed_users (
  email       text primary key,
  full_name   text,
  role        text not null default 'learner' check (role in ('admin', 'learner')),
  created_at  timestamptz not null default now()
);

-- One row per login account.
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'learner' check (role in ('admin', 'learner')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.categories (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  created_at  timestamptz not null default now()
);

create table if not exists public.questions (
  id             bigint generated always as identity primary key,
  category_id    bigint not null references public.categories (id) on delete cascade,
  question       text not null,
  options        jsonb not null check (jsonb_typeof(options) = 'array'),
  correct_index  int not null check (correct_index >= 0),
  explanation    text,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);
create index if not exists questions_category_idx on public.questions (category_id);

-- Per learner, per question progress. Box/due_at drive spaced repetition.
create table if not exists public.progress (
  user_id           uuid not null references public.profiles (id) on delete cascade,
  question_id       bigint not null references public.questions (id) on delete cascade,
  attempts          int not null default 0,
  correct           int not null default 0,
  last_correct      boolean,
  box               int not null default 0,
  due_at            timestamptz not null default now(),
  last_answered_at  timestamptz,
  primary key (user_id, question_id)
);
create index if not exists progress_question_idx on public.progress (question_id);

-- 2. Helper functions ----------------------------------------
-- Kept in a schema the API doesn't expose; only the security rules use them.
create schema if not exists private;
grant usage on schema private to authenticated;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active);
$$;

create or replace function private.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

-- 3. Invitation-only sign-up ---------------------------------
-- Any new account whose email is not in allowed_users is rejected.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a public.allowed_users%rowtype;
begin
  select * into a from public.allowed_users where lower(email) = lower(new.email);
  if not found then
    raise exception 'Sign-up is by invitation only';
  end if;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, lower(new.email), a.full_name, a.role);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 4. Row level security --------------------------------------

alter table public.allowed_users enable row level security;
alter table public.profiles      enable row level security;
alter table public.categories    enable row level security;
alter table public.questions     enable row level security;
alter table public.progress      enable row level security;

drop policy if exists "admin manages allowlist" on public.allowed_users;
create policy "admin manages allowlist" on public.allowed_users
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

drop policy if exists "read own profile or admin" on public.profiles;
create policy "read own profile or admin" on public.profiles
  for select to authenticated using (id = auth.uid() or private.is_admin());

drop policy if exists "admin updates profiles" on public.profiles;
create policy "admin updates profiles" on public.profiles
  for update to authenticated using (private.is_admin()) with check (private.is_admin());

drop policy if exists "active users read categories" on public.categories;
create policy "active users read categories" on public.categories
  for select to authenticated using (private.is_active());

drop policy if exists "admin writes categories" on public.categories;
create policy "admin writes categories" on public.categories
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

drop policy if exists "active users read questions" on public.questions;
create policy "active users read questions" on public.questions
  for select to authenticated using (private.is_active());

drop policy if exists "admin writes questions" on public.questions;
create policy "admin writes questions" on public.questions
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

-- Learners read only their own progress; admin reads everyone's.
-- Nobody writes progress directly: answers go through record_answer(),
-- which checks the answer on the server so scores can't be faked.
drop policy if exists "read own progress or admin" on public.progress;
create policy "read own progress or admin" on public.progress
  for select to authenticated using (user_id = auth.uid() or private.is_admin());

drop policy if exists "admin resets progress" on public.progress;
create policy "admin resets progress" on public.progress
  for delete to authenticated using (private.is_admin());

-- 5. App functions -------------------------------------------

-- Records one answer and updates spaced-repetition scheduling.
-- Correct answers move the card up a box (review after 1, 3, 7, 14, 30 days);
-- a wrong answer sends it back to box 0 (due again straight away).
create or replace function public.record_answer(p_question_id bigint, p_selected int)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_ok       boolean;
  v_box      int;
  v_days     int[] := array[0, 1, 3, 7, 14, 30];
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not private.is_active() then
    raise exception 'Account is not active';
  end if;

  select (correct_index = p_selected) into v_ok
  from public.questions where id = p_question_id;
  if v_ok is null then
    raise exception 'Question not found';
  end if;

  select case when v_ok then least(coalesce(p.box, 0) + 1, 5) else 0 end into v_box
  from (select 1) d
  left join public.progress p on p.user_id = auth.uid() and p.question_id = p_question_id;

  insert into public.progress as p
    (user_id, question_id, attempts, correct, last_correct, box, due_at, last_answered_at)
  values
    (auth.uid(), p_question_id, 1, case when v_ok then 1 else 0 end, v_ok, v_box,
     now() + make_interval(days => v_days[v_box + 1]), now())
  on conflict (user_id, question_id) do update set
    attempts         = p.attempts + 1,
    correct          = p.correct + case when v_ok then 1 else 0 end,
    last_correct     = v_ok,
    box              = v_box,
    due_at           = now() + make_interval(days => v_days[v_box + 1]),
    last_answered_at = now();

  return v_ok;
end;
$$;

-- Progress summed per user and category.
-- A learner gets only their own rows; the admin gets everyone's.
create or replace function public.progress_stats()
returns table (user_id uuid, category_id bigint, answered int, attempts int,
               correct int, due int, last_answered timestamptz)
language sql stable security definer set search_path = public as $$
  select p.user_id, q.category_id,
         count(*)::int,
         sum(p.attempts)::int,
         sum(p.correct)::int,
         (count(*) filter (where p.due_at <= now()))::int,
         max(p.last_answered_at)
  from public.progress p
  join public.questions q on q.id = p.question_id
  where q.active and (p.user_id = auth.uid() or private.is_admin())
  group by p.user_id, q.category_id;
$$;

-- Number of active questions per category (respects RLS).
create or replace function public.category_counts()
returns table (category_id bigint, total int)
language sql stable security invoker set search_path = public as $$
  select category_id, count(*)::int from public.questions where active group by category_id;
$$;

-- 6. Permissions ---------------------------------------------

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Functions are callable by everyone unless revoked, so lock each one down.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function private.is_admin() from public, anon;
revoke execute on function private.is_active() from public, anon;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.is_active() to authenticated;
revoke execute on function public.record_answer(bigint, int) from public, anon;
revoke execute on function public.progress_stats() from public, anon;
revoke execute on function public.category_counts() from public, anon;
grant execute on function public.record_answer(bigint, int) to authenticated;
grant execute on function public.progress_stats() to authenticated;
grant execute on function public.category_counts() to authenticated;

-- 7. First admin ---------------------------------------------
-- The first admin. Change this email if you want a different admin account.
insert into public.allowed_users (email, full_name, role)
values ('harinandbs1@gmail.com', 'Harinand', 'admin')
on conflict (email) do update set role = 'admin';
