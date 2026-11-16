-- ============================================================
-- Migration 004: account security
--  * one device at a time per learner (a new sign-in signs the old device out)
--  * sign-in history with device, IP address and country
--  * block a sign-in from a different country soon after the last one
--  * idle timeout and maximum session length, enforced by the database
-- Non-destructive: adds tables/functions, redefines two helper functions,
-- and alters (does not drop) four read policies.
-- ============================================================

-- 1. Settings (one row, edited on the admin Security page)
create table if not exists public.security_settings (
  id                  boolean primary key default true check (id),
  one_device          boolean not null default true,
  idle_minutes        int     not null default 30 check (idle_minutes between 0 and 1440),
  max_session_hours   int     not null default 12 check (max_session_hours between 0 and 720),
  country_lock_hours  int     not null default 12 check (country_lock_hours between 0 and 720),
  admins_exempt       boolean not null default true,
  updated_at          timestamptz not null default now()
);
insert into public.security_settings (id) values (true) on conflict (id) do nothing;

-- Admin can let a learner sign in from a new country until this time.
alter table public.profiles add column if not exists location_ok_until timestamptz;

-- 2. One row per signed-in session (session_id = the Supabase Auth session id in the JWT)
create table if not exists public.user_sessions (
  session_id    uuid primary key,
  user_id       uuid not null references public.profiles (id) on delete cascade,
  device        text,
  ip            text,
  country       text,
  auth_created  timestamptz,
  started_at    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  ended_at      timestamptz,
  end_reason    text check (end_reason in ('replaced', 'signed_out', 'admin', 'idle', 'expired'))
);
create index if not exists user_sessions_user_idx on public.user_sessions (user_id, started_at desc);

-- 3. Sign-in history
create table if not exists public.login_events (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references public.profiles (id) on delete cascade,
  at       timestamptz not null default now(),
  event    text not null check (event in ('login', 'blocked_location', 'replaced_other', 'admin_signout')),
  device   text,
  ip       text,
  country  text,
  detail   text
);
create index if not exists login_events_user_idx on public.login_events (user_id, at desc);

alter table public.security_settings enable row level security;
alter table public.user_sessions     enable row level security;
alter table public.login_events      enable row level security;

create policy "admin reads security settings" on public.security_settings
  for select to authenticated using ((select private.is_admin()));
create policy "admin updates security settings" on public.security_settings
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "admin reads sessions" on public.user_sessions
  for select to authenticated using ((select private.is_admin()));
create policy "admin reads login events" on public.login_events
  for select to authenticated using ((select private.is_admin()));
-- No insert/update/delete policies: rows are written only by the functions below.

-- 4. Helpers (private schema: not callable through the API)

create or replace function private.jwt_session()
returns uuid language sql stable set search_path = public as $$
  select nullif(coalesce(auth.jwt() ->> 'session_id', ''), '')::uuid;
$$;

-- State of a session: ok | exempt | none | replaced | signed_out | admin | idle | expired
create or replace function private.session_state(p_sid uuid, p_uid uuid)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  c public.security_settings%rowtype;
  s public.user_sessions%rowtype;
begin
  select * into c from public.security_settings where id;
  if c.admins_exempt and exists (select 1 from public.profiles where id = p_uid and role = 'admin') then
    return 'exempt';
  end if;
  if p_sid is null then return 'none'; end if;
  select * into s from public.user_sessions where session_id = p_sid and user_id = p_uid;
  if not found then return 'none'; end if;
  if s.ended_at is not null then return s.end_reason; end if;
  if c.max_session_hours > 0 and s.started_at <= now() - make_interval(hours => c.max_session_hours) then return 'expired'; end if;
  -- 2 minutes of grace: activity reaches the server with the once-a-minute heartbeat,
  -- and the app itself signs out at exactly idle_minutes (after a 1-minute warning)
  if c.idle_minutes > 0 and s.last_seen <= now() - make_interval(mins => c.idle_minutes + 2) then return 'idle'; end if;
  return 'ok';
end;
$$;

create or replace function private.session_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select private.session_state(private.jwt_session(), auth.uid()) in ('ok', 'exempt');
$$;

-- Existing helpers now also require a live session, so a signed-out or timed-out
-- device loses access to questions and can't record answers straight away.
create or replace function private.is_active()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active) and private.session_ok();
$$;

create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active) and private.session_ok();
$$;

create or replace function private.request_origin(out ip text, out country text)
language plpgsql stable set search_path = public as $$
declare h json;
begin
  begin
    h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  exception when others then h := '{}'::json;
  end;
  ip := nullif(trim(coalesce(h ->> 'cf-connecting-ip', split_part(h ->> 'x-forwarded-for', ',', 1), h ->> 'x-real-ip')), '');
  country := nullif(nullif(upper(trim(h ->> 'cf-ipcountry')), ''), 'XX');
end;
$$;

-- Sign out every other Supabase Auth session of a user (refresh tokens stop working).
-- Returns false if this database role isn't allowed to do that; access is still
-- blocked by session_ok() either way.
create or replace function private.kill_auth_sessions(p_uid uuid, p_keep uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  -- only sessions that started before the kept one, so a newer sign-in that
  -- hasn't registered yet is left alone (it will take over when it registers)
  delete from auth.sessions s
   where s.user_id = p_uid
     and (p_keep is null or (s.id <> p_keep and s.created_at <= coalesce(
           (select k.created_at from auth.sessions k where k.id = p_keep), 'infinity')));
  return true;
exception when others then
  return false;
end;
$$;

-- 5. API functions

-- Called right after signing in. Registers this session, applies the location rule,
-- and (one-device mode) signs out the user's other devices.
create or replace function public.claim_session(p_device text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_sid     uuid := private.jwt_session();
  c         public.security_settings%rowtype;
  p         public.profiles%rowtype;
  o         record;
  v_state   text;
  v_created timestamptz;
  v_exempt  boolean;
  v_prev    text;
  v_n       int := 0;
  v_killed  boolean := null;
  v_device  text := left(nullif(trim(p_device), ''), 80);
begin
  if v_uid is null or v_sid is null then raise exception 'Not signed in'; end if;
  select * into p from public.profiles where id = v_uid;
  if not found or not p.active then raise exception 'Account is not active'; end if;
  select * into c from public.security_settings where id;
  v_exempt := c.admins_exempt and p.role = 'admin';
  select * into o from private.request_origin();

  -- Already registered: never revive a session that was ended or has timed out.
  if exists (select 1 from public.user_sessions where session_id = v_sid) then
    v_state := private.session_state(v_sid, v_uid);
    if v_state in ('ok', 'exempt') then
      update public.user_sessions set last_seen = now() where session_id = v_sid;
      return json_build_object('ok', true, 'state', v_state, 'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours);
    end if;
    update public.user_sessions set ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, v_state)
     where session_id = v_sid and v_state in ('idle', 'expired');
    return json_build_object('ok', false, 'reason', v_state, 'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours);
  end if;

  begin
    select created_at into v_created from auth.sessions where id = v_sid;
  exception when others then v_created := null;
  end;

  if not v_exempt then
    -- An older sign-in can't take over from a newer one.
    if c.one_device and v_created is not null and exists (
      select 1 from public.user_sessions
       where user_id = v_uid and ended_at is null and auth_created > v_created) then
      return json_build_object('ok', false, 'reason', 'replaced');
    end if;

    -- Location rule: a different country within the lock window is blocked.
    if c.country_lock_hours > 0 and o.country is not null and coalesce(p.location_ok_until, '-infinity') < now() then
      select e.country into v_prev from public.login_events e
       where e.user_id = v_uid and e.event = 'login' and e.country is not null and e.country <> o.country
         and e.at > now() - make_interval(hours => c.country_lock_hours)
       order by e.at desc limit 1;
      if v_prev is not null then
        insert into public.login_events (user_id, event, device, ip, country, detail)
        values (v_uid, 'blocked_location', v_device, o.ip, o.country, 'Previous sign-in from ' || v_prev);
        return json_build_object('ok', false, 'reason', 'location', 'country', o.country, 'previous', v_prev, 'hours', c.country_lock_hours);
      end if;
    end if;

    if c.one_device then
      with ended as (
        update public.user_sessions set ended_at = now(), end_reason = 'replaced'
         where user_id = v_uid and ended_at is null and session_id <> v_sid
        returning 1)
      select count(*) into v_n from ended;
      v_killed := private.kill_auth_sessions(v_uid, v_sid);
      if v_n > 0 then
        insert into public.login_events (user_id, event, device, ip, country, detail)
        values (v_uid, 'replaced_other', v_device, o.ip, o.country, v_n || ' other device(s) signed out');
      end if;
    end if;
  end if;

  insert into public.user_sessions (session_id, user_id, device, ip, country, auth_created)
  values (v_sid, v_uid, v_device, o.ip, o.country, v_created);
  insert into public.login_events (user_id, event, device, ip, country)
  values (v_uid, 'login', v_device, o.ip, o.country);

  -- housekeeping
  delete from public.user_sessions where user_id = v_uid and ended_at < now() - interval '30 days';
  delete from public.login_events  where user_id = v_uid and at < now() - interval '180 days';

  return json_build_object('ok', true, 'state', case when v_exempt then 'exempt' else 'ok' end,
    'replaced', v_n, 'other_devices_signed_out', v_killed,
    'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours);
end;
$$;

-- Called every minute or so while the app is open. p_touch = there was activity.
create or replace function public.session_heartbeat(p_touch boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_sid   uuid := private.jwt_session();
  c       public.security_settings%rowtype;
  v_state text;
begin
  if v_uid is null then raise exception 'Not signed in'; end if;
  select * into c from public.security_settings where id;
  v_state := private.session_state(v_sid, v_uid);
  if v_state = 'ok' and p_touch then
    update public.user_sessions set last_seen = now() where session_id = v_sid;
  elsif v_state in ('idle', 'expired') then
    update public.user_sessions set ended_at = now(), end_reason = v_state where session_id = v_sid and ended_at is null;
  end if;
  return json_build_object('state', v_state, 'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours);
end;
$$;

-- Sign-out button: close this session's row.
create or replace function public.end_my_session()
returns void language sql security definer set search_path = public as $$
  update public.user_sessions set ended_at = now(), end_reason = 'signed_out'
   where session_id = private.jwt_session() and user_id = auth.uid() and ended_at is null;
$$;

-- Admin: sign a user out of every device now.
create or replace function public.admin_sign_out_user(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not private.is_admin() then raise exception 'Only an admin can do this'; end if;
  with ended as (
    update public.user_sessions set ended_at = now(), end_reason = 'admin'
     where user_id = p_user and ended_at is null
    returning 1)
  select count(*) into v_n from ended;
  perform private.kill_auth_sessions(p_user, case when p_user = auth.uid() then private.jwt_session() end);
  insert into public.login_events (user_id, event, detail) values (p_user, 'admin_signout', v_n || ' session(s) ended by admin');
  return v_n;
end;
$$;

-- 6. Evaluate the access check once per query instead of once per row.
alter policy "active users read questions"   on public.questions   using ((select private.is_active()));
alter policy "active users read categories"  on public.categories  using ((select private.is_active()));
alter policy "active users read disciplines" on public.disciplines using ((select private.is_active()));
alter policy "add own marks" on public.marks
  with check (user_id = (select auth.uid()) and (select private.is_active()));

-- 7. Permissions
grant select, update on public.security_settings to authenticated;
grant select on public.user_sessions, public.login_events to authenticated;
revoke all on public.security_settings, public.user_sessions, public.login_events from anon;

revoke execute on function private.jwt_session(), private.session_state(uuid, uuid), private.session_ok(),
  private.request_origin(), private.kill_auth_sessions(uuid, uuid) from public, anon;
grant execute on function private.jwt_session(), private.session_state(uuid, uuid), private.session_ok(),
  private.request_origin() to authenticated;

revoke execute on function public.claim_session(text), public.session_heartbeat(boolean),
  public.end_my_session(), public.admin_sign_out_user(uuid) from public, anon;
grant execute on function public.claim_session(text), public.session_heartbeat(boolean),
  public.end_my_session(), public.admin_sign_out_user(uuid) to authenticated;
