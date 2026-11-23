-- Migration 019: keep the detailed answers of each learner's latest 3 finished mock exams only.
-- For older mocks the picked options and the per-question mark are cleared, but whether each
-- answer was right stays, so progress, readiness and the Incorrect pool are unchanged.
-- The mock's own score (correct, points) stays too. Runs whenever a mock is finished, and once now.

alter table public.sessions add column if not exists details_cleared boolean not null default false;

create or replace function private.trim_mock_details(p_uid uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_ids bigint[];
begin
  select coalesce(array_agg(id), '{}') into v_ids from (
    select id, details_cleared, row_number() over (order by started_at desc, id desc) rn
      from public.sessions where user_id = p_uid and mode = 'mock' and finished_at is not null) x
   where rn > 3 and not details_cleared;
  if cardinality(v_ids) = 0 then return 0; end if;
  update public.answers set selected = '{}', mark = null where session_id = any (v_ids);
  update public.sessions set details_cleared = true where id = any (v_ids);
  return cardinality(v_ids);
end $$;
revoke all on function private.trim_mock_details(uuid) from public, anon, authenticated;

create or replace function private.mock_finished() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform private.trim_mock_details(new.user_id);
  return null;
end $$;
revoke all on function private.mock_finished() from public, anon, authenticated;
drop trigger if exists mock_finished on public.sessions;
create trigger mock_finished after update of finished_at on public.sessions
  for each row when (new.mode = 'mock' and new.finished_at is not null and old.finished_at is null)
  execute function private.mock_finished();

-- Once now, for everyone.
select private.trim_mock_details(u.user_id) from (select distinct user_id from public.sessions where mode = 'mock') u;
