-- ============================================================
-- Migration 012: admin tools.
--  1. notice_reads: who tapped "Got it" on each notice (read counts for the
--     admin; dismissals now follow the learner across devices).
--  2. question_history: every edit or deletion of a question is logged with
--     the old and new version, so it can be undone. Bulk imports are not logged.
--  3. admin_most_missed / admin_overview: admin-only statistics, calculated in
--     the database (security invoker: they only see what row-level security
--     already lets the admin see).
--  4. most_missed_ids: question ids only (no names, no numbers) so learners
--     can practise the group's most-missed questions.
-- Non-destructive.
-- ============================================================

-- 1. Notice read receipts
create table if not exists public.notice_reads (
  announcement_id text not null references public.announcements (id) on delete cascade on update cascade,
  user_id         uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  seen_at         timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
create index if not exists notice_reads_user_idx on public.notice_reads (user_id);
alter table public.notice_reads enable row level security;
drop policy if exists "users read own notice reads, admin reads all" on public.notice_reads;
create policy "users read own notice reads, admin reads all" on public.notice_reads
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "users record own notice reads" on public.notice_reads;
create policy "users record own notice reads" on public.notice_reads
  for insert to authenticated with check (user_id = (select auth.uid()) and (select private.is_active()));
revoke all on public.notice_reads from anon, authenticated;
grant select on public.notice_reads to authenticated;
grant insert (announcement_id, user_id) on public.notice_reads to authenticated;

-- 2. Question change history
create table if not exists public.question_history (
  id           bigint generated always as identity primary key,
  question_id  bigint not null,
  action       text not null check (action in ('update', 'delete')),
  changed_at   timestamptz not null default now(),
  changed_by   uuid default auth.uid(),
  old_row      jsonb not null,
  new_row      jsonb,
  key_changed  boolean not null default false
);
create index if not exists question_history_q_idx on public.question_history (question_id, changed_at desc);
alter table public.question_history enable row level security;
drop policy if exists "admin reads question history" on public.question_history;
create policy "admin reads question history" on public.question_history
  for select to authenticated using ((select private.is_admin()));
revoke all on public.question_history from anon, authenticated;
grant select on public.question_history to authenticated;

create or replace function private.log_question_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  o jsonb := jsonb_build_object('category_id', old.category_id, 'question', old.question, 'options', old.options,
     'correct', to_jsonb(old.correct), 'correct_index', old.correct_index, 'qtype', old.qtype, 'explanation', old.explanation, 'active', old.active);
  n jsonb;
begin
  if tg_op = 'DELETE' then
    insert into public.question_history (question_id, action, old_row, new_row, key_changed) values (old.id, 'delete', o, null, false);
    return old;
  end if;
  n := jsonb_build_object('category_id', new.category_id, 'question', new.question, 'options', new.options,
     'correct', to_jsonb(new.correct), 'correct_index', new.correct_index, 'qtype', new.qtype, 'explanation', new.explanation, 'active', new.active);
  if n is distinct from o then
    insert into public.question_history (question_id, action, old_row, new_row, key_changed)
    values (new.id, 'update', o, n,
            (old.correct is distinct from new.correct)
            or (select jsonb_agg(old.options->k order by k) from unnest(old.correct) k)
               is distinct from (select jsonb_agg(new.options->k order by k) from unnest(new.correct) k));
  end if;
  return new;
end $$;
revoke all on function private.log_question_change() from public, anon, authenticated;
drop trigger if exists questions_history on public.questions;
create trigger questions_history after update or delete on public.questions
  for each row execute function private.log_question_change();

-- 3. Admin statistics (security invoker + explicit admin check)
create or replace function public.admin_most_missed(p_limit int default 20, p_min int default 3)
returns table (question_id bigint, learners int, wrong int, wrong_pct int, common_wrong int[], common_wrong_n int)
language plpgsql stable set search_path = public as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  return query
  with first_try as (
    select distinct on (a.user_id, a.question_id) a.user_id, a.question_id, a.selected, a.is_correct
    from public.answers a order by a.user_id, a.question_id, a.answered_at
  ), agg as (
    select f.question_id, count(*)::int n, count(*) filter (where not f.is_correct)::int w
    from first_try f join public.questions q on q.id = f.question_id
    group by f.question_id having count(*) >= p_min
  ), picks as (
    select f.question_id, f.selected, count(*)::int c,
           row_number() over (partition by f.question_id order by count(*) desc) rn
    from first_try f where not f.is_correct group by f.question_id, f.selected
  )
  select g.question_id, g.n, g.w, round(100.0 * g.w / g.n)::int, p.selected, coalesce(p.c, 0)
  from agg g left join picks p on p.question_id = g.question_id and p.rn = 1
  where g.w > 0
  order by g.w::numeric / g.n desc, g.n desc, g.question_id
  limit least(greatest(p_limit, 1), 100);
end $$;
revoke all on function public.admin_most_missed(int, int) from public, anon;
grant execute on function public.admin_most_missed(int, int) to authenticated;

create or replace function public.admin_overview()
returns json language plpgsql stable set search_path = public as $$
begin
  if not private.is_admin() then raise exception 'Admins only'; end if;
  return json_build_object(
    'db_bytes', pg_database_size(current_database()),
    'tables', (select json_agg(t) from (select c.relname as name, pg_total_relation_size(c.oid) as bytes
                 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relkind = 'r' order by 2 desc limit 6) t),
    'answers_24h', (select count(*) from public.answers where answered_at > now() - interval '24 hours'),
    'answers_7d', (select count(*) from public.answers where answered_at > now() - interval '7 days'),
    'learners_24h', (select count(distinct user_id) from public.answers where answered_at > now() - interval '24 hours'),
    'learners_7d', (select count(distinct user_id) from public.answers where answered_at > now() - interval '7 days'),
    'open_sessions', (select count(*) from public.user_sessions where ended_at is null and last_seen > now() - interval '30 minutes'),
    'connections', (select count(*) from pg_stat_activity),
    'max_connections', current_setting('max_connections')::int,
    'mock_exams', (select count(*) from public.sessions where mode = 'mock' and finished_at is not null));
end $$;
revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

-- 4. Learners: ids of the group's most-missed questions (no personal data)
create or replace function public.most_missed_ids(p_limit int default 20)
returns setof bigint language sql stable security definer set search_path = public as $$
  with first_try as (
    select distinct on (a.user_id, a.question_id) a.question_id, a.is_correct
    from public.answers a order by a.user_id, a.question_id, a.answered_at
  )
  select f.question_id from first_try f
  join public.questions q on q.id = f.question_id and q.active
  where private.is_active()
  group by f.question_id having count(*) >= 3 and count(*) filter (where not f.is_correct) > 0
  order by count(*) filter (where not f.is_correct)::numeric / count(*) desc, count(*) desc, f.question_id
  limit least(greatest(p_limit, 1), 50);
$$;
revoke all on function public.most_missed_ids(int) from public, anon;
grant execute on function public.most_missed_ids(int) to authenticated;
