-- Migration 015: geo-fencing. The app can only be used from the countries in
-- security_settings.geo_countries (default Moldova and Saudi Arabia).
--  * Checked on every database request (through private.session_state, which every
--    learner policy and function already uses), not just at sign-in.
--  * A request whose country can't be determined is blocked.
--  * Admins follow the existing "Admins are exempt" setting.
--  * An empty list switches the fence off.
-- claim_session and session_heartbeat below are the live definitions with the geo check added.

alter table public.security_settings add column if not exists geo_countries text[] not null default '{MD,SA}';
alter table public.security_settings drop constraint if exists security_settings_geo_countries_check;
alter table public.security_settings add constraint security_settings_geo_countries_check
  check (cardinality(geo_countries) <= 50 and array_to_string(geo_countries, ',') ~ '^([A-Z]{2}(,[A-Z]{2})*)?$');

alter table public.login_events drop constraint if exists login_events_event_check;
alter table public.login_events add constraint login_events_event_check
  check (event in ('login', 'blocked_location', 'replaced_other', 'admin_signout', 'blocked_country'));
alter table public.user_sessions drop constraint if exists user_sessions_end_reason_check;
alter table public.user_sessions add constraint user_sessions_end_reason_check
  check (end_reason in ('replaced', 'signed_out', 'admin', 'idle', 'expired', 'country'));

-- The country of the current request if it is outside the allowed list ('unknown' if it
-- can't be determined); null when it is allowed or the fence is off.
create or replace function private.geo_block()
returns text language plpgsql stable security definer set search_path = public as $$
declare v_allowed text[]; v_country text;
begin
  select geo_countries into v_allowed from public.security_settings where id;
  if v_allowed is null or cardinality(v_allowed) = 0 then return null; end if;
  select country into v_country from private.request_origin();
  if v_country is null then return 'unknown'; end if;
  if v_country = any (v_allowed) then return null; end if;
  return v_country;
end $$;
revoke all on function private.geo_block() from public, anon;
grant execute on function private.geo_block() to authenticated;

create or replace function private.session_state(p_sid uuid, p_uid uuid)
 returns text language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  c public.security_settings%rowtype;
  s public.user_sessions%rowtype;
begin
  select * into c from public.security_settings where id;
  if c.admins_exempt and exists (select 1 from public.profiles where id = p_uid and role = 'admin') then
    return 'exempt';
  end if;
  if private.geo_block() is not null then return 'country'; end if;
  if p_sid is null then return 'none'; end if;
  select * into s from public.user_sessions where session_id = p_sid and user_id = p_uid;
  if not found then return 'none'; end if;
  if s.ended_at is not null then return s.end_reason; end if;
  if c.max_session_hours > 0 and s.started_at <= now() - make_interval(hours => c.max_session_hours) then return 'expired'; end if;
  if c.idle_minutes > 0 and s.last_seen <= now() - make_interval(mins => c.idle_minutes + 2) then return 'idle'; end if;
  return 'ok';
end;
$function$;

create or replace function public.session_heartbeat(p_touch boolean default false)
 returns json language plpgsql security definer set search_path to 'public'
as $function$
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
  elsif v_state in ('idle', 'expired', 'country') then
    update public.user_sessions set ended_at = now(), end_reason = v_state where session_id = v_sid and ended_at is null;
  end if;
  return json_build_object('state', v_state, 'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours,
    'country', case when v_state = 'country' then private.geo_block() end, 'allowed', c.geo_countries);
end;
$function$;

create or replace function public.claim_session(p_device text default null::text)
 returns json language plpgsql security definer set search_path to 'public'
as $function$
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
  v_geo     text;
begin
  if v_uid is null or v_sid is null then raise exception 'Not signed in'; end if;
  select * into p from public.profiles where id = v_uid;
  if not found or not p.active then raise exception 'Account is not active'; end if;
  select * into c from public.security_settings where id;
  v_exempt := c.admins_exempt and p.role = 'admin';
  select * into o from private.request_origin();

  -- Geo-fence: refuse use from outside the allowed countries.
  if not v_exempt then
    v_geo := private.geo_block();
    if v_geo is not null then
      if not exists (select 1 from public.login_events where user_id = v_uid and event = 'blocked_country'
                      and at > now() - interval '10 minutes' and coalesce(country, '?') = coalesce(o.country, '?')) then
        insert into public.login_events (user_id, event, device, ip, country, detail)
        values (v_uid, 'blocked_country', v_device, o.ip, o.country,
                'Outside allowed countries (' || array_to_string(c.geo_countries, ', ') || ')');
      end if;
      update public.user_sessions set ended_at = coalesce(ended_at, now()), end_reason = coalesce(end_reason, 'country')
       where session_id = v_sid;
      return json_build_object('ok', false, 'reason', 'country', 'country', v_geo, 'allowed', c.geo_countries);
    end if;
  end if;

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
    if c.one_device and v_created is not null and exists (
      select 1 from public.user_sessions
       where user_id = v_uid and ended_at is null and auth_created > v_created) then
      return json_build_object('ok', false, 'reason', 'replaced');
    end if;

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

  delete from public.user_sessions where user_id = v_uid and ended_at < now() - interval '30 days';
  delete from public.login_events  where user_id = v_uid and at < now() - interval '180 days';

  return json_build_object('ok', true, 'state', case when v_exempt then 'exempt' else 'ok' end,
    'replaced', v_n, 'other_devices_signed_out', v_killed,
    'idle_minutes', c.idle_minutes, 'max_session_hours', c.max_session_hours);
end;
$function$;

-- The security notice learners accept lists the allowed countries too.
create or replace function public.security_summary()
 returns json language sql stable security definer set search_path to 'public'
as $function$
  select json_build_object('one_device', one_device, 'idle_minutes', idle_minutes,
    'max_session_hours', max_session_hours, 'country_lock_hours', country_lock_hours, 'geo_countries', geo_countries)
  from public.security_settings
  where id and exists (select 1 from public.profiles where id = auth.uid() and active);
$function$;
