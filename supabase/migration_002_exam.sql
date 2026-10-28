-- ============================================================
-- Migration 002: exam structure, multiple-answer questions,
-- practice sessions and answer history (for the improvement curve).
-- Safe to run once on a database created with schema.sql.
-- ============================================================

-- 1. Disciplines (the exam blueprint: share of the exam per discipline)
create table if not exists public.disciplines (
  id       bigint generated always as identity primary key,
  name     text not null unique,
  profile  text not null,
  weight   numeric not null check (weight >= 0),
  sort     int not null default 0
);

-- Topics (categories) belong to a discipline. Topic names stay unique across the bank.
alter table public.categories add column if not exists discipline_id bigint references public.disciplines (id) on delete cascade;

-- 2. Questions: single (CS) or multiple (CM) choice with a set of correct options.
-- The original single-answer column correct_index is kept (filled with the first correct option)
-- so this migration removes nothing.
alter table public.questions add column if not exists qtype text not null default 'CS' check (qtype in ('CS', 'CM'));
alter table public.questions add column if not exists correct int[] check (correct is null or cardinality(correct) >= 1);
alter table public.questions add column if not exists source text;
update public.questions set correct = array[correct_index] where correct is null;

-- 3. Practice sessions and answer log
create table if not exists public.sessions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  mode         text not null check (mode in ('topic', 'mock', 'review')),
  label        text,
  total        int not null default 0,
  answered     int not null default 0,
  correct      int not null default 0,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists sessions_user_idx on public.sessions (user_id, started_at);

create table if not exists public.answers (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  session_id   bigint references public.sessions (id) on delete cascade,
  question_id  bigint not null references public.questions (id) on delete cascade,
  selected     int[] not null,
  is_correct   boolean not null,
  answered_at  timestamptz not null default now()
);
create index if not exists answers_user_idx on public.answers (user_id, answered_at);
create index if not exists answers_session_idx on public.answers (session_id);
create index if not exists answers_question_idx on public.answers (question_id);

-- 4. Row level security for the new tables
alter table public.disciplines enable row level security;
alter table public.sessions    enable row level security;
alter table public.answers     enable row level security;

create policy "active users read disciplines" on public.disciplines
  for select to authenticated using (private.is_active());
create policy "admin writes disciplines" on public.disciplines
  for all to authenticated using (private.is_admin()) with check (private.is_admin());

-- Learners see their own sessions and answers, the admin sees everyone's.
-- Writes go only through the functions below.
create policy "read own sessions or admin" on public.sessions
  for select to authenticated using (user_id = auth.uid() or private.is_admin());
create policy "admin deletes sessions" on public.sessions
  for delete to authenticated using (private.is_admin());

create policy "read own answers or admin" on public.answers
  for select to authenticated using (user_id = auth.uid() or private.is_admin());
create policy "admin deletes answers" on public.answers
  for delete to authenticated using (private.is_admin());

-- 5. Functions

-- Start a practice session; returns its id.
create or replace function public.start_session(p_mode text, p_label text, p_total int)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not private.is_active() then raise exception 'Account is not active'; end if;
  insert into public.sessions (user_id, mode, label, total)
  values (auth.uid(), p_mode, left(p_label, 200), greatest(p_total, 0))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.finish_session(p_session_id bigint)
returns void language sql security definer set search_path = public as $$
  update public.sessions set finished_at = coalesce(finished_at, now())
  where id = p_session_id and user_id = auth.uid();
$$;

-- Record one answer. Correct only when the chosen set equals the key exactly.
-- Updates spaced-repetition scheduling, the answer log and the session score.
create or replace function public.record_answer(p_question_id bigint, p_selected int[], p_session_id bigint default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_key   int[];
  v_sel   int[];
  v_ok    boolean;
  v_box   int;
  v_days  int[] := array[0, 1, 3, 7, 14, 30];
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not private.is_active() then raise exception 'Account is not active'; end if;

  select array(select x from unnest(coalesce(correct, array[correct_index])) x order by x) into v_key
  from public.questions where id = p_question_id;
  if v_key is null then raise exception 'Question not found'; end if;
  v_sel := array(select distinct x from unnest(coalesce(p_selected, '{}')) x order by x);
  v_ok := v_sel = v_key;

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

  if p_session_id is not null then
    if not exists (select 1 from public.sessions where id = p_session_id and user_id = auth.uid()) then
      raise exception 'Session not found';
    end if;
    insert into public.answers (user_id, session_id, question_id, selected, is_correct)
    values (auth.uid(), p_session_id, p_question_id, v_sel, v_ok);
    update public.sessions
       set answered = answered + 1, correct = correct + case when v_ok then 1 else 0 end
     where id = p_session_id;
  else
    insert into public.answers (user_id, question_id, selected, is_correct)
    values (auth.uid(), p_question_id, v_sel, v_ok);
  end if;

  return v_ok;
end;
$$;

-- 6. Permissions
grant select, insert, update, delete on public.disciplines, public.sessions, public.answers to authenticated;
grant usage, select on all sequences in schema public to authenticated;
revoke all on public.disciplines, public.sessions, public.answers from anon;

revoke execute on function public.start_session(text, text, int) from public, anon;
revoke execute on function public.finish_session(bigint) from public, anon;
revoke execute on function public.record_answer(bigint, int[], bigint) from public, anon;
-- the old single-answer function stays but can no longer be called
revoke execute on function public.record_answer(bigint, int) from public, anon, authenticated;
grant execute on function public.start_session(text, text, int) to authenticated;
grant execute on function public.finish_session(bigint) to authenticated;
grant execute on function public.record_answer(bigint, int[], bigint) to authenticated;
