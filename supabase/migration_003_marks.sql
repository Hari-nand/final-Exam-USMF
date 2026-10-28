-- Migration 003: questions a learner has marked (flagged) for later review.
create table if not exists public.marks (
  user_id     uuid   not null references public.profiles (id) on delete cascade,
  question_id bigint not null references public.questions (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);
create index if not exists marks_question_idx on public.marks (question_id);

alter table public.marks enable row level security;

create policy "read own marks or admin" on public.marks
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy "add own marks" on public.marks
  for insert to authenticated with check (user_id = (select auth.uid()) and (select private.is_active()));
create policy "remove own marks or admin" on public.marks
  for delete to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));

grant select, insert, delete on public.marks to authenticated;
revoke all on public.marks from anon;
