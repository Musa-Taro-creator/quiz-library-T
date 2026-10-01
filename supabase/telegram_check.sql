-- Quiz Library — check payments against your ABA Telegram group.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.
--
-- How it works: a spare Telegram account (a member of your ABA group) is
-- read by the "abacheck" Edge Function. Every "PayWay by ABA" message
-- (amount + transaction number) is saved here. When a student pays your shop
-- QR and types the transaction number from their receipt, it is matched with
-- these messages — if it matches and the amount is enough, the plan switches
-- on by itself. Each transaction number can be used only once.

-- ABA messages read from the Telegram group
create table if not exists public.ql_tg_payments (
  trx_id      text primary key,                 -- លេខប្រតិបត្តិការ / Trx. ID
  amount      numeric(14,2) not null,
  currency    text not null,                    -- USD | KHR
  payer       text,
  apv         text,
  paid_at     timestamptz not null,
  raw         text,
  msg_id      bigint,
  seen_at     timestamptz not null default now(),
  used_by     uuid,
  used_for    uuid,                             -- ql_payment_requests.id
  used_at     timestamptz
);
create index if not exists ql_tg_payments_paid on public.ql_tg_payments (paid_at desc);

-- The spare Telegram account's login (only the Edge Function can read it)
create table if not exists public.ql_tg_session (
  id          int primary key default 1 check (id = 1),
  session     text,
  phone       text,
  code_hash   text,
  account     text,
  chat_id     text,
  chat_title  text,
  last_sync   timestamptz,
  last_error  text,
  updated_at  timestamptz not null default now()
);
insert into public.ql_tg_session (id) values (1) on conflict do nothing;

alter table public.ql_tg_payments enable row level security;
alter table public.ql_tg_session  enable row level security;
revoke all on public.ql_tg_payments, public.ql_tg_session from anon, authenticated;

-- The number the student typed
alter table public.ql_payment_requests add column if not exists trx_ref text;
alter table public.ql_payment_requests add column if not exists method  text not null default 'receipt';  -- receipt | trx | aba
alter table public.ql_payment_requests add column if not exists tran_id  text;   -- used by ABA PayWay API (aba_payway.sql)
alter table public.ql_payment_requests add column if not exists currency text not null default 'USD';

create or replace function public.ql__digits(p text)
returns text language sql immutable as $$
  select regexp_replace(translate(coalesce(p, ''), '០១២៣៤៥៦៧៨៩', '0123456789'), '[^0-9]', '', 'g');
$$;

-- Student: "I paid — here is my transaction number" (receipt photo optional)
create or replace function public.ql_submit_payment_trx(p_plan text, p_period text, p_trx text, p_receipt text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p ql_plans;
  v_amount numeric;
  v_trx text := ql__digits(p_trx);
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from ql_plans where id = p_plan and visibility = 'public';
  if v_p.id is null or v_p.is_default then raise exception 'That plan is not available.'; end if;
  v_amount := case p_period when 'month' then v_p.price_month when 'year' then v_p.price_year when 'lifetime' then v_p.price_lifetime end;
  if v_amount is null then raise exception 'That payment option is not available.'; end if;
  if length(v_trx) < 6 then raise exception 'Please type the transaction number from your receipt.'; end if;
  if length(coalesce(p_receipt, '')) > 1500000 then raise exception 'The receipt photo is too large.'; end if;
  if exists (select 1 from ql_tg_payments where trx_id = v_trx and used_by is not null and used_by <> v_uid)
     or exists (select 1 from ql_payment_requests where trx_ref = v_trx and status = 'approved') then
    raise exception 'This transaction number was already used.';
  end if;
  if (select count(*) from ql_payment_requests where user_id = v_uid and status = 'waiting') >= 3 then
    raise exception 'You already have payments waiting for approval.';
  end if;
  insert into ql_payment_requests (user_id, plan_id, period, amount, receipt, trx_ref, method)
  values (v_uid, p_plan, p_period, v_amount, nullif(p_receipt, ''), v_trx, 'trx') returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_submit_payment_trx(text, text, text, text) from public, anon;
grant execute on function public.ql_submit_payment_trx(text, text, text, text) to authenticated;

-- Try to match one waiting payment with a saved ABA message.
-- Returns: approved | waiting (not found yet) | low (amount too small) | used | handled
create or replace function public.ql__tg_match(p_payment uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  r ql_payment_requests;
  t ql_tg_payments;
  v_rate numeric;
  v_need numeric;
  v_ok boolean;
begin
  select * into r from ql_payment_requests where id = p_payment for update;
  if r.id is null then raise exception 'Payment not found'; end if;
  if r.status <> 'waiting' then return case when r.status = 'approved' then 'approved' else 'handled' end; end if;
  if coalesce(r.trx_ref, '') = '' then return 'waiting'; end if;

  select * into t from ql_tg_payments
   where trx_id = r.trx_ref or (length(r.trx_ref) >= 8 and (trx_id like '%' || r.trx_ref or r.trx_ref like '%' || trx_id))
   order by (trx_id = r.trx_ref) desc limit 1 for update;
  if t.trx_id is null then return 'waiting'; end if;
  if t.used_by is not null and t.used_for is distinct from r.id then
    update ql_payment_requests set admin_note = 'This transaction number was already used by another payment' where id = r.id;
    return 'used';
  end if;
  if t.paid_at < r.created_at - interval '3 days' then
    update ql_payment_requests set admin_note = 'ABA payment is older than 3 days — please check' where id = r.id;
    return 'used';
  end if;

  select coalesce(nullif(value->>'khr_rate', '')::numeric, 4100) into v_rate from ql_site_settings where key = 'payment';
  v_need := case when t.currency = 'KHR' then r.amount * coalesce(v_rate, 4100) * 0.98 else r.amount - 0.001 end;
  v_ok := t.amount >= v_need;
  if not v_ok then
    update ql_payment_requests set admin_note = format('ABA shows %s %s — less than the price (%s USD)', t.amount, t.currency, r.amount) where id = r.id;
    return 'low';
  end if;

  update ql_tg_payments set used_by = r.user_id, used_for = r.id, used_at = now() where trx_id = t.trx_id;
  update ql_payment_requests set status = 'approved', decided_at = now(), trx_ref = t.trx_id,
         admin_note = format('Checked with ABA automatically (%s %s, %s)', t.amount, t.currency, coalesce(t.payer, '')) where id = r.id;
  perform ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
  return 'approved';
end;
$$;
revoke all on function public.ql__tg_match(uuid) from public, anon, authenticated;
grant execute on function public.ql__tg_match(uuid) to service_role;

-- Save ABA messages read from Telegram (Edge Function only). Returns how many were new.
create or replace function public.ql__tg_store(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  insert into ql_tg_payments (trx_id, amount, currency, payer, apv, paid_at, raw, msg_id)
  select x->>'trx_id', (x->>'amount')::numeric, x->>'currency', x->>'payer', x->>'apv', (x->>'paid_at')::timestamptz, x->>'raw', (x->>'msg_id')::bigint
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
   where coalesce(x->>'trx_id', '') <> '' and (x->>'amount') ~ '^[0-9]+(\.[0-9]+)?$'
  on conflict (trx_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.ql__tg_store(jsonb) from public, anon, authenticated;
grant execute on function public.ql__tg_store(jsonb) to service_role;

-- Waiting payments that have a transaction number (to re-check)
create or replace function public.ql__tg_waiting(p_uid uuid)
returns table (id uuid) language sql stable security definer set search_path = public as $$
  select id from ql_payment_requests
   where status = 'waiting' and coalesce(trx_ref, '') <> '' and (p_uid is null or user_id = p_uid)
     and created_at > now() - interval '7 days'
   order by created_at desc limit 50;
$$;
revoke all on function public.ql__tg_waiting(uuid) from public, anon, authenticated;
grant execute on function public.ql__tg_waiting(uuid) to service_role;

create or replace function public.ql__tg_is_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select ql__is_admin(p_uid);
$$;
revoke all on function public.ql__tg_is_admin(uuid) from public, anon, authenticated;
grant execute on function public.ql__tg_is_admin(uuid) to service_role;

-- Admin: recent ABA messages (and who used them)
create or replace function public.ql_admin_tg_payments(p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.paid_at desc) from (
    select t.trx_id, t.amount, t.currency, t.payer, t.apv, t.paid_at, t.used_at, u.email as used_email
      from ql_tg_payments t left join auth.users u on u.id = t.used_by
     order by t.paid_at desc limit greatest(1, least(coalesce(p_limit, 100), 500))) x), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_tg_payments(integer) from public, anon;
grant execute on function public.ql_admin_tg_payments(integer) to authenticated;

-- Admin: connection status of the spare Telegram account
create or replace function public.ql_admin_tg_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return (select jsonb_build_object('connected', session is not null and code_hash is null, 'waiting_code', code_hash is not null,
                                    'phone', phone, 'account', account, 'chat_id', chat_id, 'chat_title', chat_title,
                                    'last_sync', last_sync, 'last_error', last_error,
                                    'messages', (select count(*) from ql_tg_payments))
            from ql_tg_session where id = 1);
end;
$$;
revoke all on function public.ql_admin_tg_status() from public, anon;
grant execute on function public.ql_admin_tg_status() to authenticated;

-- Admin payments list: show the matching ABA message next to each waiting payment
create or replace function public.ql_admin_payments(p_status text default 'waiting')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
           'email', u.email, 'name', coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
           'tg', (select to_jsonb(t) - 'raw' from ql_tg_payments t
                   where coalesce(r.trx_ref, '') <> '' and (t.trx_id = r.trx_ref
                         or (length(r.trx_ref) >= 8 and (t.trx_id like '%' || r.trx_ref or r.trx_ref like '%' || t.trx_id)))
                   limit 1)) order by r.created_at desc)
    from (select * from ql_payment_requests
           where (p_status = 'aba' and method = 'aba') or (p_status <> 'aba' and status = p_status)
           order by created_at desc limit 300) r
    left join auth.users u on u.id = r.user_id), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_payments(text) from public, anon;
grant execute on function public.ql_admin_payments(text) to authenticated;

-- Admin approving by hand also marks the ABA message as used
create or replace function public.ql_admin_decide_payment(p_id uuid, p_approve boolean, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r ql_payment_requests;
begin
  perform ql__need_admin();
  select * into r from ql_payment_requests where id = p_id for update;
  if r.id is null or r.status not in ('waiting', 'pending', 'expired', 'failed') then raise exception 'This payment was already handled'; end if;
  update ql_payment_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = coalesce(nullif(p_note, ''), case when p_approve and r.method in ('aba', 'trx') then 'Approved by admin' else '' end),
         decided_at = now() where id = p_id;
  if p_approve then
    if coalesce(r.trx_ref, '') <> '' then
      update ql_tg_payments set used_by = r.user_id, used_for = r.id, used_at = now() where trx_id = r.trx_ref and used_by is null;
    end if;
    perform ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
  end if;
end;
$$;
revoke all on function public.ql_admin_decide_payment(uuid, boolean, text) from public, anon;
grant execute on function public.ql_admin_decide_payment(uuid, boolean, text) to authenticated;

-- Students' history shows the transaction number too
drop function if exists public.ql_my_payments();
create or replace function public.ql_my_payments()
returns table (id uuid, plan_id text, period text, amount numeric, status text, admin_note text,
               created_at timestamptz, decided_at timestamptz, method text, trx_ref text, tran_id text, currency text)
language sql stable security definer set search_path = public as $$
  select id, plan_id, period, amount, status, admin_note, created_at, decided_at, method, trx_ref, tran_id, currency
    from ql_payment_requests
   where user_id = auth.uid() and not (method = 'aba' and status in ('pending', 'expired'))
   order by created_at desc limit 50;
$$;
revoke all on function public.ql_my_payments() from public, anon;
grant execute on function public.ql_my_payments() to authenticated;

notify pgrst, 'reload schema';
