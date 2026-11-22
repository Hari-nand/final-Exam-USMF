-- Migration 017: learners must acknowledge every live notice before starting a test.
-- The app shows the unread notices straight after sign-in and lets learners in only
-- once all are acknowledged; this makes the database refuse new practice tests and
-- mock exams too, so the rule can't be skipped. Admins are not affected.
-- start_session below is the live definition with the check added.

create or replace function private.unread_notices(p_uid uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from public.announcements a
   where a.show_from <= now() and (a.show_until is null or a.show_until > now())
     and not exists (select 1 from public.notice_reads r where r.announcement_id = a.id and r.user_id = p_uid);
$$;
revoke all on function private.unread_notices(uuid) from public, anon, authenticated;

create or replace function public.start_session(p_mode text, p_label text, p_total integer)
 returns bigint language plpgsql security definer set search_path to 'public'
as $function$
declare v_id bigint; v_unread int;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not private.is_active() then raise exception 'Account is not active'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin') then
    v_unread := private.unread_notices(auth.uid());
    if v_unread > 0 then
      raise exception 'Please read and acknowledge the % new notice(s) first. Open the bell at the top and press Got it.', v_unread
        using errcode = 'P0001', hint = 'unread_notices';
    end if;
  end if;
  insert into public.sessions (user_id, mode, label, total)
  values (auth.uid(), p_mode, left(p_label, 200), greatest(p_total, 0))
  returning id into v_id;
  return v_id;
end;
$function$;
