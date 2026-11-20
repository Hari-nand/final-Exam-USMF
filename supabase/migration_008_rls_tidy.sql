-- ============================================================
-- Migration 008: RLS performance tidy-up (Supabase advisors).
-- Same access as before:
--  * admin "write" policies no longer also cover SELECT
--    (admins already pass the read policies: is_admin implies is_active);
--  * auth.uid() / private.is_admin() wrapped in (select ...) so they are
--    evaluated once per query instead of once per row.
-- ============================================================

-- questions, categories, disciplines: split admin FOR ALL into insert/update/delete
do $$
declare t text;
begin
  foreach t in array array['questions', 'categories', 'disciplines'] loop
    execute format('drop policy if exists "admin writes %1$s" on public.%1$I', t);
    execute format('drop policy if exists "admin inserts %1$s" on public.%1$I', t);
    execute format('drop policy if exists "admin updates %1$s" on public.%1$I', t);
    execute format('drop policy if exists "admin deletes %1$s" on public.%1$I', t);
    execute format('create policy "admin inserts %1$s" on public.%1$I for insert to authenticated with check ((select private.is_admin()))', t);
    execute format('create policy "admin updates %1$s" on public.%1$I for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()))', t);
    execute format('create policy "admin deletes %1$s" on public.%1$I for delete to authenticated using ((select private.is_admin()))', t);
  end loop;
end $$;

-- announcements: same split (the read policy already lets admins see everything)
drop policy if exists "admin manages announcements" on public.announcements;
drop policy if exists "admin inserts announcements" on public.announcements;
drop policy if exists "admin updates announcements" on public.announcements;
drop policy if exists "admin deletes announcements" on public.announcements;
create policy "admin inserts announcements" on public.announcements for insert to authenticated with check ((select private.is_admin()));
create policy "admin updates announcements" on public.announcements for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "admin deletes announcements" on public.announcements for delete to authenticated using ((select private.is_admin()));

-- read-own-or-admin policies: evaluate auth.uid() / is_admin() once per query
drop policy if exists "read own profile or admin" on public.profiles;
create policy "read own profile or admin" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "read own progress or admin" on public.progress;
create policy "read own progress or admin" on public.progress
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "read own sessions or admin" on public.sessions;
create policy "read own sessions or admin" on public.sessions
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "read own answers or admin" on public.answers;
create policy "read own answers or admin" on public.answers
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
