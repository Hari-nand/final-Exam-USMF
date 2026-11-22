-- Migration 014: feedback & suggestions, and message threads on reports and feedback
--  * public.feedback: a learner's feedback or suggestion ticket (open / under review / closed)
--  * public.ticket_messages: messages between the learner and the admin on a question report
--    or a feedback ticket. The learner can write while the ticket is open; only the admin closes it.
--  * notifications: a message or status change from the admin notifies the learner
--  * existing admin replies on reports become the first admin message of their thread

-- ---------------------------------------------------------------- feedback tickets
create table if not exists public.feedback (
  id             bigint generated always as identity primary key,
  user_id        uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  kind           text not null default 'feedback' check (kind in ('feedback', 'suggestion')),
  subject        text not null check (char_length(trim(subject)) between 3 and 120),
  body           text not null check (char_length(trim(body)) between 3 and 2000),
  status         text not null default 'open' check (status in ('open', 'in_review', 'closed')),
  awaiting_admin boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  closed_at      timestamptz,
  closed_by      uuid references public.profiles (id) on delete set null
);
create index if not exists feedback_user_idx on public.feedback (user_id, created_at desc);
create index if not exists feedback_active_idx on public.feedback (status) where status <> 'closed';
create index if not exists feedback_closed_by_idx on public.feedback (closed_by);

alter table public.feedback enable row level security;
drop policy if exists "users read own feedback, admin reads all" on public.feedback;
create policy "users read own feedback, admin reads all" on public.feedback
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
drop policy if exists "users add own feedback" on public.feedback;
create policy "users add own feedback" on public.feedback
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'open' and closed_at is null and closed_by is null
    and (select private.is_active()));
drop policy if exists "admin updates feedback" on public.feedback;
create policy "admin updates feedback" on public.feedback
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));

revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;
grant insert (kind, subject, body) on public.feedback to authenticated;
grant update (status) on public.feedback to authenticated;

create or replace function private.feedback_stamps() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.feedback where user_id = new.user_id and created_at > now() - interval '1 day') >= 10 then
      raise exception 'You have sent 10 feedback messages today. Please try again tomorrow.';
    end if;
    new.subject := trim(new.subject); new.body := trim(new.body);
    return new;
  end if;
  new.updated_at := now();
  if new.status = 'closed' and old.status <> 'closed' then
    new.closed_at := now(); new.closed_by := auth.uid(); new.awaiting_admin := false;
  elsif new.status <> 'closed' then
    new.closed_at := null; new.closed_by := null;
  end if;
  return new;
end $$;
drop trigger if exists feedback_stamps on public.feedback;
create trigger feedback_stamps before insert or update on public.feedback
  for each row execute function private.feedback_stamps();

-- Reports get the same "waiting for the admin" flag, so the Reports tab can show it.
alter table public.question_reports add column if not exists awaiting_admin boolean not null default false;
update public.question_reports set awaiting_admin = true where status = 'open' and awaiting_admin = false;

-- ---------------------------------------------------------------- messages
create table if not exists public.ticket_messages (
  id          bigint generated always as identity primary key,
  report_id   bigint references public.question_reports (id) on delete cascade,
  feedback_id bigint references public.feedback (id) on delete cascade,
  author      uuid default auth.uid() references public.profiles (id) on delete set null,
  from_admin  boolean not null default false,
  body        text not null check (char_length(trim(body)) between 1 and 2000),
  created_at  timestamptz not null default now(),
  check ((report_id is null) <> (feedback_id is null))
);
create index if not exists ticket_messages_report_idx on public.ticket_messages (report_id, created_at) where report_id is not null;
create index if not exists ticket_messages_feedback_idx on public.ticket_messages (feedback_id, created_at) where feedback_id is not null;
create index if not exists ticket_messages_author_idx on public.ticket_messages (author);

-- Is the signed-in user the owner of this ticket, and is it still open?
create or replace function private.ticket_owner_open(p_report bigint, p_feedback bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_report is not null then exists (select 1 from public.question_reports r
      where r.id = p_report and r.user_id = auth.uid() and r.status in ('open', 'in_review'))
    else exists (select 1 from public.feedback f
      where f.id = p_feedback and f.user_id = auth.uid() and f.status in ('open', 'in_review'))
  end;
$$;
create or replace function private.ticket_owner(p_report bigint, p_feedback bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p_report is not null then exists (select 1 from public.question_reports r where r.id = p_report and r.user_id = auth.uid())
    else exists (select 1 from public.feedback f where f.id = p_feedback and f.user_id = auth.uid())
  end;
$$;
revoke all on function private.ticket_owner_open(bigint, bigint), private.ticket_owner(bigint, bigint) from public, anon;
grant execute on function private.ticket_owner_open(bigint, bigint), private.ticket_owner(bigint, bigint) to authenticated;

alter table public.ticket_messages enable row level security;
drop policy if exists "read messages on own tickets, admin reads all" on public.ticket_messages;
create policy "read messages on own tickets, admin reads all" on public.ticket_messages
  for select to authenticated using ((select private.is_admin()) or private.ticket_owner(report_id, feedback_id));
drop policy if exists "write on own open ticket, admin on any" on public.ticket_messages;
create policy "write on own open ticket, admin on any" on public.ticket_messages
  for insert to authenticated with check (
    author = (select auth.uid()) and (select private.is_active())
    and ((select private.is_admin()) or private.ticket_owner_open(report_id, feedback_id)));

revoke all on public.ticket_messages from anon, authenticated;
grant select on public.ticket_messages to authenticated;
grant insert (report_id, feedback_id, body) on public.ticket_messages to authenticated;

create or replace function private.ticket_message_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Rows written without a signed-in user (this migration's back-fill) keep the values given.
  if auth.uid() is null then return new; end if;
  new.author := auth.uid();
  new.from_admin := private.is_admin();
  new.body := trim(new.body);
  new.created_at := now();
  if not new.from_admin and (select count(*) from public.ticket_messages
       where author = new.author and created_at > now() - interval '1 day') >= 50 then
    raise exception 'You have sent 50 messages today. Please try again tomorrow.';
  end if;
  return new;
end $$;
drop trigger if exists ticket_message_before on public.ticket_messages;
create trigger ticket_message_before before insert on public.ticket_messages
  for each row execute function private.ticket_message_before();

-- ---------------------------------------------------------------- notifications
alter table public.notifications add column if not exists feedback_id bigint references public.feedback (id) on delete cascade;
create index if not exists notifications_feedback_idx on public.notifications (feedback_id);
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check check (kind in ('report_update', 'feedback_update'));

-- After a message: flag who is waiting, and tell the learner when the admin wrote.
create or replace function private.ticket_message_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  if auth.uid() is null then return null; end if;  -- back-fill: no flags, no notifications
  if new.report_id is not null then
    update public.question_reports set awaiting_admin = not new.from_admin where id = new.report_id returning user_id into v_owner;
    if new.from_admin and v_owner is distinct from new.author then
      delete from public.notifications where report_id = new.report_id and seen_at is null;
      insert into public.notifications (user_id, kind, report_id) values (v_owner, 'report_update', new.report_id);
    end if;
  else
    update public.feedback set awaiting_admin = not new.from_admin, updated_at = now() where id = new.feedback_id returning user_id into v_owner;
    if new.from_admin and v_owner is distinct from new.author then
      delete from public.notifications where feedback_id = new.feedback_id and seen_at is null;
      insert into public.notifications (user_id, kind, feedback_id) values (v_owner, 'feedback_update', new.feedback_id);
    end if;
  end if;
  return null;
end $$;
drop trigger if exists ticket_message_after on public.ticket_messages;
create trigger ticket_message_after after insert on public.ticket_messages
  for each row execute function private.ticket_message_after();

create or replace function private.notify_feedback_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is distinct from auth.uid() then
    delete from public.notifications where feedback_id = new.id and seen_at is null;
    insert into public.notifications (user_id, kind, feedback_id) values (new.user_id, 'feedback_update', new.id);
  end if;
  return null;
end $$;
drop trigger if exists feedback_notify on public.feedback;
create trigger feedback_notify after update on public.feedback
  for each row when (old.status is distinct from new.status) execute function private.notify_feedback_update();

revoke all on function private.feedback_stamps(), private.ticket_message_before(), private.ticket_message_after(),
  private.notify_feedback_update() from public, anon, authenticated;

-- ---------------------------------------------------------------- existing replies become messages
insert into public.ticket_messages (report_id, author, from_admin, body, created_at)
select r.id, r.resolved_by, true, r.admin_reply, coalesce(r.replied_at, r.created_at)
  from public.question_reports r
 where nullif(trim(r.admin_reply), '') is not null
   and not exists (select 1 from public.ticket_messages m where m.report_id = r.id);
