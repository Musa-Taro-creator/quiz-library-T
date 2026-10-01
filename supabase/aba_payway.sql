-- Quiz Library — automatic payments with ABA PayWay (KHQR).
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.
--
-- How it works: the student taps "Choose Pro", the "payway" Edge Function asks
-- ABA for a KHQR made for that exact payment, and keeps checking with ABA.
-- The moment ABA says APPROVED (and the amount is right) the plan switches on
-- by itself. Your ABA Merchant ID and API key live only in the Edge Function
-- secrets — never in this database or in the website files.

alter table public.ql_payment_requests add column if not exists method     text not null default 'receipt'; -- receipt | aba
alter table public.ql_payment_requests add column if not exists tran_id    text;
alter table public.ql_payment_requests add column if not exists currency   text not null default 'USD';
alter table public.ql_payment_requests add column if not exists expires_at timestamptz;
alter table public.ql_payment_requests add column if not exists paid_at    timestamptz;
alter table public.ql_payment_requests add column if not exists aba_apv    text;      -- ABA approval code
alter table public.ql_payment_requests add column if not exists aba_amount numeric(12,2);
alter table public.ql_payment_requests add column if not exists checked_at timestamptz;
create unique index if not exists ql_payment_requests_tran on public.ql_payment_requests (tran_id) where tran_id is not null;
-- status for ABA payments: pending (QR shown) | approved | expired | failed | waiting (needs you to look)

-- Start an ABA payment (called only by the Edge Function).
create or replace function public.ql__aba_start(p_uid uuid, p_plan text, p_period text, p_currency text, p_minutes integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_p ql_plans;
  v_amount numeric;
  v_tran text;
  v_row ql_payment_requests;
begin
  if p_uid is null then raise exception 'not authenticated'; end if;
  select * into v_p from ql_plans where id = p_plan and visibility = 'public';
  if v_p.id is null or v_p.is_default then raise exception 'That plan is not available.'; end if;
  v_amount := case p_period when 'month' then v_p.price_month when 'year' then v_p.price_year when 'lifetime' then v_p.price_lifetime end;
  if v_amount is null or v_amount <= 0 then raise exception 'That payment option is not available.'; end if;
  if (select count(*) from ql_payment_requests
       where user_id = p_uid and method = 'aba' and created_at > now() - interval '30 minutes') >= 8 then
    raise exception 'Too many QR codes in a short time. Please wait a few minutes.';
  end if;
  -- ABA allows up to 20 characters and each one must be unique.
  v_tran := 'QL' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                 || upper(substr(md5(random()::text || p_uid::text), 1, 6));
  insert into ql_payment_requests (user_id, plan_id, period, amount, status, method, tran_id, currency, expires_at)
  values (p_uid, p_plan, p_period, v_amount, 'pending', 'aba', v_tran, upper(coalesce(nullif(p_currency, ''), 'USD')),
          now() + make_interval(mins => greatest(3, coalesce(p_minutes, 10))))
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'tran_id', v_row.tran_id, 'amount', v_row.amount, 'currency', v_row.currency,
                            'expires_at', v_row.expires_at, 'plan_name', v_p.name,
                            'email', (select email from auth.users where id = p_uid));
end;
$$;
revoke all on function public.ql__aba_start(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.ql__aba_start(uuid, text, text, text, integer) to service_role;

-- Save what ABA said about one payment (called only by the Edge Function).
-- p_state: paid | pending | failed | refunded. Paying twice never gives double days.
create or replace function public.ql__aba_update(p_tran_id text, p_state text, p_amount numeric, p_currency text, p_apv text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r ql_payment_requests;
  v_sub ql_subscriptions;
begin
  select * into r from ql_payment_requests where tran_id = p_tran_id and method = 'aba' for update;
  if r.id is null then raise exception 'Payment not found'; end if;
  update ql_payment_requests set checked_at = now() where id = r.id;

  if p_state = 'paid' and r.status in ('pending', 'expired', 'failed') then
    if p_amount is null or p_amount + 0.001 < r.amount or upper(coalesce(p_currency, r.currency)) <> r.currency then
      update ql_payment_requests set status = 'waiting', paid_at = now(), aba_apv = p_apv, aba_amount = p_amount,
             admin_note = format('ABA paid %s %s but the plan costs %s %s — please check', p_amount, coalesce(p_currency, ''), r.amount, r.currency)
       where id = r.id;
    else
      update ql_payment_requests set status = 'approved', decided_at = now(), paid_at = now(), aba_apv = p_apv, aba_amount = p_amount,
             admin_note = 'Paid automatically with ABA' where id = r.id;
      v_sub := ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
    end if;
  elsif p_state = 'failed' and r.status = 'pending' then
    update ql_payment_requests set status = 'failed', admin_note = 'Payment was not completed' where id = r.id;
  elsif p_state = 'refunded' and r.status = 'approved' then
    update ql_payment_requests set admin_note = 'ABA says this payment was refunded — check the plan' where id = r.id;
  elsif p_state = 'pending' and r.status = 'pending' and r.expires_at < now() - interval '2 minutes' then
    update ql_payment_requests set status = 'expired' where id = r.id;
  end if;

  select * into r from ql_payment_requests where id = r.id;
  return jsonb_build_object('id', r.id, 'tran_id', r.tran_id, 'status', r.status, 'user_id', r.user_id,
                            'plan_id', r.plan_id, 'expires_at', r.expires_at, 'admin_note', r.admin_note);
end;
$$;
revoke all on function public.ql__aba_update(text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.ql__aba_update(text, text, numeric, text, text) to service_role;

-- ABA payments that may still turn into "paid" (checked again when the
-- student opens the app, and by "Check with ABA" in admin).
create or replace function public.ql__aba_open(p_uid uuid)
returns table (tran_id text, user_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select tran_id, user_id, status from ql_payment_requests
   where method = 'aba' and tran_id is not null
     and (p_uid is null or user_id = p_uid)
     and (status = 'pending' or (status in ('expired', 'failed') and created_at > now() - interval '2 days'))
     and created_at > now() - interval '7 days'
   order by created_at desc limit 40;
$$;
revoke all on function public.ql__aba_open(uuid) from public, anon, authenticated;
grant execute on function public.ql__aba_open(uuid) to service_role;

-- The Edge Function checks the admin with this (service_role call).
create or replace function public.ql__aba_is_admin(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select ql__is_admin(p_uid);
$$;
revoke all on function public.ql__aba_is_admin(uuid) from public, anon, authenticated;
grant execute on function public.ql__aba_is_admin(uuid) to service_role;

-- Students' payment history now also shows ABA payments.
drop function if exists public.ql_my_payments();
create or replace function public.ql_my_payments()
returns table (id uuid, plan_id text, period text, amount numeric, status text, admin_note text,
               created_at timestamptz, decided_at timestamptz, method text, tran_id text, currency text)
language sql stable security definer set search_path = public as $$
  select id, plan_id, period, amount, status, admin_note, created_at, decided_at, method, tran_id, currency
    from ql_payment_requests
   where user_id = auth.uid() and not (method = 'aba' and status in ('pending', 'expired'))
   order by created_at desc limit 50;
$$;
revoke all on function public.ql_my_payments() from public, anon;
grant execute on function public.ql_my_payments() to authenticated;

-- Admin can also switch on a plan by hand for an ABA payment that was
-- expired / failed / needs checking (e.g. the student shows you the ABA receipt).
create or replace function public.ql_admin_decide_payment(p_id uuid, p_approve boolean, p_note text default '')
returns void language plpgsql security definer set search_path = public as $$
declare r ql_payment_requests;
begin
  perform ql__need_admin();
  select * into r from ql_payment_requests where id = p_id for update;
  if r.id is null or r.status not in ('waiting', 'pending', 'expired', 'failed') then raise exception 'This payment was already handled'; end if;
  update ql_payment_requests set status = case when p_approve then 'approved' else 'rejected' end,
         admin_note = coalesce(nullif(p_note, ''), case when p_approve and r.method = 'aba' then 'Approved by admin' else '' end),
         decided_at = now() where id = p_id;
  if p_approve then
    perform ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
  end if;
end;
$$;
revoke all on function public.ql_admin_decide_payment(uuid, boolean, text) from public, anon;
grant execute on function public.ql_admin_decide_payment(uuid, boolean, text) to authenticated;

-- Admin list: 'aba' shows every ABA payment (any status).
create or replace function public.ql_admin_payments(p_status text default 'waiting')
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object(
           'email', u.email, 'name', coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1))) order by r.created_at desc)
    from (select * from ql_payment_requests
           where (p_status = 'aba' and method = 'aba') or (p_status <> 'aba' and status = p_status)
           order by created_at desc limit 300) r
    left join auth.users u on u.id = r.user_id), '[]'::jsonb);
end;
$$;
revoke all on function public.ql_admin_payments(text) from public, anon;
grant execute on function public.ql_admin_payments(text) to authenticated;

notify pgrst, 'reload schema';
