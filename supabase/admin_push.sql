-- Quiz Library — notifications for the admin.
-- When a student sends a Help & Support message or a payment receipt, the admin's
-- phone / computer gets a notification (even when the admin app is closed).
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql and support_messages.sql.
-- Then create the Edge Function "ql-push" (supabase/functions/ql-push/index.ts).
-- Safe to run again.

create extension if not exists pg_net with schema extensions;

-- keys + where to send (only the database and the Edge Function can read this)
create table if not exists public.ql_push_config (
  id          integer primary key default 1 check (id = 1),
  public_key  text,
  private_key text,
  secret      text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  fn_url      text,
  updated_at  timestamptz not null default now()
);
alter table public.ql_push_config enable row level security;
revoke all on public.ql_push_config from anon, authenticated;

-- the admin's devices that turned notifications on
create table if not exists public.ql_push_subs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  label      text,
  created_at timestamptz not null default now()
);
alter table public.ql_push_subs enable row level security;
revoke all on public.ql_push_subs from anon, authenticated;

-- admin: save the keys made in the admin page (only the first time, unless p_replace)
create or replace function public.ql_admin_push_setup(p_public text, p_private text, p_fn_url text, p_replace boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare c ql_push_config;
begin
  perform ql__need_admin();
  insert into ql_push_config (id) values (1) on conflict (id) do nothing;
  select * into c from ql_push_config where id = 1;
  if c.public_key is null or p_replace then
    update ql_push_config set public_key = p_public, private_key = p_private, updated_at = now() where id = 1;
    if p_replace then delete from ql_push_subs; end if;
  end if;
  update ql_push_config set fn_url = p_fn_url where id = 1;
  return (select public_key from ql_push_config where id = 1);
end;
$$;
revoke all on function public.ql_admin_push_setup(text, text, text, boolean) from public, anon;
grant execute on function public.ql_admin_push_setup(text, text, text, boolean) to authenticated;

create or replace function public.ql_admin_push_info()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return jsonb_build_object(
    'public_key', (select public_key from ql_push_config where id = 1),
    'devices', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'endpoint', endpoint, 'label', label, 'created_at', created_at) order by created_at)
                          from ql_push_subs), '[]'::jsonb));
end;
$$;
revoke all on function public.ql_admin_push_info() from public, anon;
grant execute on function public.ql_admin_push_info() to authenticated;

create or replace function public.ql_admin_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if coalesce(p_endpoint, '') !~ '^https://' then raise exception 'Bad notification address'; end if;
  insert into ql_push_subs (user_id, endpoint, p256dh, auth, label) values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_label, 80))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, user_id = excluded.user_id;
end;
$$;
revoke all on function public.ql_admin_push_subscribe(text, text, text, text) from public, anon;
grant execute on function public.ql_admin_push_subscribe(text, text, text, text) to authenticated;

create or replace function public.ql_admin_push_remove(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  delete from ql_push_subs where id = p_id;
end;
$$;
revoke all on function public.ql_admin_push_remove(uuid) from public, anon;
grant execute on function public.ql_admin_push_remove(uuid) to authenticated;

-- send a notification to every admin device (never blocks or breaks the insert that called it)
create or replace function public.ql__push(p_title text, p_body text, p_url text, p_tag text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare c ql_push_config;
begin
  select * into c from ql_push_config where id = 1;
  if c.fn_url is null or c.public_key is null or not exists (select 1 from ql_push_subs) then return; end if;
  perform net.http_post(
    url := c.fn_url,
    body := jsonb_build_object('title', p_title, 'body', p_body, 'url', p_url, 'tag', p_tag),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-ql-push', c.secret));
exception when others then
  null;
end;
$$;
revoke all on function public.ql__push(text, text, text, text) from public, anon, authenticated;

create or replace function public.ql_admin_push_test()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  perform ql__push('🔔 Quiz Library', 'Notifications are working!', 'admin.html#msgs', 'ql-test');
end;
$$;
revoke all on function public.ql_admin_push_test() from public, anon;
grant execute on function public.ql_admin_push_test() to authenticated;

-- new Help & Support message from a student
create or replace function public.ql__push_on_support()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if new.from_admin then return new; end if;
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)) into v_name from auth.users where id = new.user_id;
  perform ql__push('💬 ' || coalesce(v_name, 'A student'),
                   case when new.body <> '' then left(new.body, 140) else '📷 Sent a photo' end,
                   'admin.html#msgs', 'ql-msg-' || new.user_id);
  return new;
end;
$$;
drop trigger if exists ql_push_on_support on public.ql_support_msgs;
create trigger ql_push_on_support after insert on public.ql_support_msgs for each row execute function public.ql__push_on_support();

-- new payment receipt waiting for approval
create or replace function public.ql__push_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_plan text;
begin
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)) into v_name from auth.users where id = new.user_id;
  select name into v_plan from ql_plans where id = new.plan_id;
  perform ql__push('💳 New payment receipt',
                   coalesce(v_name, 'A student') || ' · ' || coalesce(v_plan, new.plan_id) || ' · $' || coalesce(new.amount::text, '?'),
                   'admin.html#pay', 'ql-pay');
  return new;
end;
$$;
drop trigger if exists ql_push_on_payment on public.ql_payment_requests;
create trigger ql_push_on_payment after insert on public.ql_payment_requests for each row execute function public.ql__push_on_payment();

notify pgrst, 'reload schema';
