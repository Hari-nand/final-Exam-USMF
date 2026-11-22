-- Migration 016: device fingerprinting with consent
--  * Everyone accepts the device & cookie consent once (again if the version goes up);
--    it is required to use the app, like the security notice.
--  * public.devices: one row per account per device fingerprint. Written only through
--    record_device() after consent; readable only by admins.
--  * Stored values from the device arrive with sign-in tokens and keys already hidden
--    by the app; the database hides anything that still looks like a token.
--  * Devices not seen for 90 days are deleted.

alter table public.profiles add column if not exists device_consent_version int not null default 0;
alter table public.profiles add column if not exists device_consent_at timestamptz;

create or replace function public.accept_device_consent(p_version int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if p_version is null or p_version < 1 or p_version > 100 then raise exception 'Bad version'; end if;
  update public.profiles set device_consent_version = p_version, device_consent_at = now() where id = auth.uid();
end $$;
revoke all on function public.accept_device_consent(int) from public, anon;
grant execute on function public.accept_device_consent(int) to authenticated;

create table if not exists public.devices (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  fingerprint  text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  device_id    text check (device_id ~ '^[0-9a-f-]{36}$'),      -- the app's own cookie
  label        text check (char_length(label) <= 120),
  details      jsonb not null default '{}' check (octet_length(details::text) <= 12000),
  storage      jsonb not null default '[]' check (octet_length(storage::text) <= 24000),
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  times_seen   int not null default 1,
  last_ip      text,
  last_country text,
  unique (user_id, fingerprint)
);
create index if not exists devices_fingerprint_idx on public.devices (fingerprint);
create index if not exists devices_device_id_idx on public.devices (device_id);
create index if not exists devices_last_seen_idx on public.devices (last_seen);

alter table public.devices enable row level security;
drop policy if exists "admin reads devices" on public.devices;
create policy "admin reads devices" on public.devices for select to authenticated using ((select private.is_admin()));
revoke all on public.devices from anon, authenticated;
grant select on public.devices to authenticated;

alter table public.user_sessions add column if not exists fingerprint text;

-- Called by the app after sign-in. Needs a current consent and an active account.
create or replace function public.record_device(p_fingerprint text, p_device_id text, p_label text, p_details jsonb, p_storage jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare o record; v_storage jsonb;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if not private.is_active() then raise exception 'Account is not active'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and device_consent_version >= 1) then
    raise exception 'Device consent not given';
  end if;
  if p_fingerprint !~ '^[0-9a-f]{64}$' then raise exception 'Bad fingerprint'; end if;
  if p_device_id is not null and p_device_id !~ '^[0-9a-f-]{36}$' then p_device_id := null; end if;
  if jsonb_typeof(coalesce(p_details, '{}')) <> 'object' or jsonb_typeof(coalesce(p_storage, '[]')) <> 'array' then
    raise exception 'Bad device details';
  end if;
  -- Belt and braces: hide anything that still looks like a token (JWT) or a key.
  select coalesce(jsonb_agg(case
           when e ->> 'value' ~ '(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.' or e ->> 'name' ~* '(token|secret|password|apikey|api_key|auth)'
           then jsonb_set(e, '{value}', '"[hidden]"') else e end), '[]')
    into v_storage from jsonb_array_elements(coalesce(p_storage, '[]')) e;
  select * into o from private.request_origin();
  insert into public.devices (user_id, fingerprint, device_id, label, details, storage, last_ip, last_country)
  values (auth.uid(), p_fingerprint, p_device_id, left(p_label, 120), coalesce(p_details, '{}'), v_storage, o.ip, o.country)
  on conflict (user_id, fingerprint) do update set
    device_id = coalesce(excluded.device_id, devices.device_id), label = excluded.label, details = excluded.details,
    storage = excluded.storage, last_seen = now(), times_seen = devices.times_seen + 1,
    last_ip = excluded.last_ip, last_country = excluded.last_country;
  update public.user_sessions set fingerprint = p_fingerprint where session_id = private.jwt_session() and user_id = auth.uid();
end $$;
revoke all on function public.record_device(text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.record_device(text, text, text, jsonb, jsonb) to authenticated;

-- Retention: devices not seen for 90 days go with the other sign-in data.
create or replace function private.retention_sweep() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.login_events where at < now() - interval '90 days';
  update public.notice_acceptances set ip = null, country = null
   where accepted_at < now() - interval '90 days' and (ip is not null or country is not null);
  delete from public.devices where last_seen < now() - interval '90 days';
  return null;
end $$;
revoke all on function private.retention_sweep() from public, anon, authenticated;
