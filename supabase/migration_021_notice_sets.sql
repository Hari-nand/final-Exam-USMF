-- Migration 021: notices for one question set only.
-- announcements.set_id: NULL = every learner; otherwise only learners who have that
-- set (and admins) can read the notice. The notice gate (unread_notices, used by
-- start_session) counts only notices the learner can see.

alter table public.announcements
  add column if not exists set_id smallint references public.question_sets(id) on delete cascade;
create index if not exists announcements_set_id_idx on public.announcements (set_id);

drop policy if exists "users read live announcements" on public.announcements;
create policy "users read live announcements" on public.announcements for select to authenticated
  using (
    ((show_from <= now()) and ((show_until is null) or (show_until > now()))
      and (set_id is null or set_id = any ((select private.my_sets())::smallint[])))
    or (select private.is_admin())
  );

create or replace function private.unread_notices(p_uid uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.announcements a
   where a.show_from <= now() and (a.show_until is null or a.show_until > now())
     and (a.set_id is null
          or exists (select 1 from public.set_access s where s.user_id = p_uid and s.set_id = a.set_id))
     and not exists (select 1 from public.notice_reads r where r.announcement_id = a.id and r.user_id = p_uid);
$$;
revoke all on function private.unread_notices(uuid) from public, anon, authenticated;

-- Existing notices about USMF questions, the USMF question bank or the USMF mock exam
-- belong to USMF Final 2026. App-wide notices stay for everyone.
update public.announcements set set_id = 1
 where id in ('q27-duplicate-2026-11-23', 'question-fixes-2026-11-22', 'most-missed-2026-11-22',
              'q2442-fix-2026-11-22', 'qbank-2026-11-20', 'qbank-2026-11-20-pre',
              'mock-good-luck-2026-11-24', 'features-2026-11-20-v2');
