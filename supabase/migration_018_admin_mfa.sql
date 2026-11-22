-- Migration 018: two-step sign-in (authenticator app codes) for admins.
--  * An admin who has set up an authenticator must have entered a code in this
--    sign-in (token aal = 'aal2') for any admin power to work.
--  * An admin who has not set one up yet keeps admin powers, so they can set it up;
--    the app makes the setup compulsory at their next sign-in.
--  * Learners are not affected.
-- private.is_admin() is used by every admin policy and function, so this one change covers them all.

create or replace function private.mfa_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;
revoke all on function private.mfa_ok() from public, anon;
grant execute on function private.mfa_ok() to authenticated;

create or replace function private.is_admin()
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active)
     and private.session_ok() and private.mfa_ok();
$function$;
