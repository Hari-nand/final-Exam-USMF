-- ============================================================
-- Migration 011: partial marks in mock exams (new mock exams only).
--  * Multi-answer (CM) question: mark = (correct options picked - wrong options
--    picked) / number of correct options. It can go below 0.
--  * Single-answer (CS) question: 1 if right, 0 if wrong or blank.
--  * Each mock answer stores its mark; each NEW mock session keeps a running
--    points total. Mock sessions from before this change keep points = null
--    and are scored as before (whole questions right / total).
--  * Topic tests, reviews, progress and spaced repetition are unchanged.
-- ============================================================

alter table public.answers  add column if not exists mark   numeric(7,4);
alter table public.sessions add column if not exists points numeric(9,4);   -- null on all existing rows
alter table public.sessions alter column points set default null;

create or replace function public.record_answer(p_question_id bigint, p_selected integer[], p_session_id bigint default null)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_key   int[];
  v_sel   int[];
  v_ok    boolean;
  v_box   int;
  v_days  int[] := array[0, 1, 3, 7, 14, 30];
  v_type  text;
  v_mode  text;
  v_mark  numeric;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not private.is_active() then raise exception 'Account is not active'; end if;

  select array(select x from unnest(coalesce(correct, array[correct_index])) x order by x), qtype
    into v_key, v_type
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
    select mode into v_mode from public.sessions where id = p_session_id and user_id = auth.uid();
    if not found then raise exception 'Session not found'; end if;

    if v_mode = 'mock' then
      if v_type = 'CM' then
        v_mark := ((select count(*) from unnest(v_sel) s where s = any(v_key))
                 - (select count(*) from unnest(v_sel) s where not (s = any(v_key))))::numeric
                 / greatest(cardinality(v_key), 1);
      else
        v_mark := case when v_ok then 1 else 0 end;
      end if;
    end if;

    insert into public.answers (user_id, session_id, question_id, selected, is_correct, mark)
    values (auth.uid(), p_session_id, p_question_id, v_sel, v_ok, v_mark);
    update public.sessions
       set answered = answered + 1,
           correct  = correct + case when v_ok then 1 else 0 end,
           points   = case when v_mode = 'mock' then coalesce(points, 0) + v_mark else points end
     where id = p_session_id;
  else
    insert into public.answers (user_id, question_id, selected, is_correct)
    values (auth.uid(), p_question_id, v_sel, v_ok);
  end if;

  return v_ok;
end;
$function$;

-- create or replace keeps the existing execute rights (authenticated: yes, anon: no).
