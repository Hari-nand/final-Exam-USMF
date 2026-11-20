-- ============================================================
-- Migration 009: unfinished tests are saved in the database, so a
-- learner can continue a practice test or mock exam on any device.
-- One saved test per learner per kind ('practice' or 'exam').
-- Non-destructive. The app falls back gracefully if this has not been run.
-- ============================================================

create table if not exists public.test_drafts (
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind        text not null check (kind in ('practice', 'exam')),
  session_id  bigint not null references public.sessions (id) on delete cascade,
  state       jsonb not null check (jsonb_typeof(state) = 'object' and octet_length(state::text) <= 200000),
  updated_at  timestamptz not null default now(),
  primary key (user_id, kind)
);
create index if not exists test_drafts_session_idx on public.test_drafts (session_id);

alter table public.test_drafts enable row level security;

drop policy if exists "users read own drafts" on public.test_drafts;
create policy "users read own drafts" on public.test_drafts
  for select to authenticated using (user_id = (select auth.uid()));

-- A draft can only point at the learner's own, still-open session.
drop policy if exists "users add own drafts" on public.test_drafts;
create policy "users add own drafts" on public.test_drafts
  for insert to authenticated with check (
    user_id = (select auth.uid()) and (select private.is_active())
    and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.finished_at is null));

drop policy if exists "users update own drafts" on public.test_drafts;
create policy "users update own drafts" on public.test_drafts
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid()) and (select private.is_active())
    and exists (select 1 from public.sessions s where s.id = session_id and s.user_id = (select auth.uid()) and s.finished_at is null));

drop policy if exists "users delete own drafts" on public.test_drafts;
create policy "users delete own drafts" on public.test_drafts
  for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.test_drafts from anon, authenticated;
grant select, insert, update, delete on public.test_drafts to authenticated;
