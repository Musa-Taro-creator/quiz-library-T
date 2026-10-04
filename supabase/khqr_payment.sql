-- Quiz Library — pay with KHQR (Bakong). The student sees YOUR KHQR with the exact
-- price already filled in, pays in any bank app, then taps "I paid".
-- For now the admin still approves (Payments). Later, with the Bakong API token,
-- the plan can switch on by itself (the QR's md5 is saved for that check).
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql and plan_sale.sql. Safe to run again.
-- Then in admin → Settings → Payment details, type your Bakong ID (e.g. name@bkrt).

alter table public.ql_payment_requests add column if not exists method   text not null default 'receipt';  -- receipt | khqr
alter table public.ql_payment_requests add column if not exists bill     text;   -- bill number in the QR (e.g. QL7K2M9X)
alter table public.ql_payment_requests add column if not exists khqr     text;   -- the full QR text
alter table public.ql_payment_requests add column if not exists khqr_md5 text;   -- Bakong looks payments up by this
create unique index if not exists ql_payment_requests_khqr_md5 on public.ql_payment_requests (khqr_md5) where khqr_md5 is not null;

-- read one EMV/KHQR field (tag) from a QR text; p_sub reads a field inside that field
create or replace function public.ql__khqr_tag(p_qr text, p_tag text, p_sub text default null)
returns text language plpgsql immutable as $$
declare i int := 1; t text; n int; v text;
begin
  while i + 3 <= length(p_qr) loop
    t := substr(p_qr, i, 2);
    n := substr(p_qr, i + 2, 2)::int;
    v := substr(p_qr, i + 4, n);
    if t = p_tag then
      if p_sub is null then return v; end if;
      return ql__khqr_tag(v, p_sub);
    end if;
    i := i + 4 + n;
  end loop;
  return null;
exception when others then
  return null;
end;
$$;

-- student: "I paid" with KHQR
create or replace function public.ql_submit_khqr(p_plan text, p_period text, p_qr text, p_receipt text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p ql_plans;
  v_amount numeric;
  v_id uuid;
  v_acc text := lower(trim(coalesce((select value->>'bakong_id' from ql_site_settings where key = 'payment'), '')));
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from ql_plans where id = p_plan and visibility = 'public';
  if v_p.id is null then raise exception 'That plan is not available.'; end if;
  v_amount := ql__plan_price(v_p, p_period);
  if v_amount is null then raise exception 'That payment option is not available.'; end if;
  if v_acc = '' then raise exception 'KHQR payment is not set up yet.'; end if;
  if length(coalesce(p_qr, '')) not between 60 and 600
     or lower(coalesce(ql__khqr_tag(p_qr, '29', '00'), '')) <> v_acc
     or ql__khqr_tag(p_qr, '53') <> '840'
     or coalesce(ql__khqr_tag(p_qr, '54'), '') !~ '^\d+(\.\d{1,2})?$'
     or ql__khqr_tag(p_qr, '54')::numeric <> v_amount then
    raise exception 'The QR is out of date. Please open the payment again.';
  end if;
  if p_receipt is not null and (left(p_receipt, 11) <> 'data:image/' or length(p_receipt) > 1500000) then
    raise exception 'The receipt photo is too large.';
  end if;
  if (select count(*) from ql_payment_requests where user_id = v_uid and status = 'waiting') >= 3 then
    raise exception 'You already have payments waiting for approval.';
  end if;
  insert into ql_payment_requests (user_id, plan_id, period, amount, receipt, method, bill, khqr, khqr_md5)
  values (v_uid, p_plan, p_period, v_amount, nullif(p_receipt, ''), 'khqr', left(ql__khqr_tag(p_qr, '62', '01'), 25), p_qr, md5(p_qr))
  on conflict do nothing
  returning id into v_id;
  if v_id is null then raise exception 'This payment was already sent.'; end if;
  return v_id;
end;
$$;
revoke all on function public.ql_submit_khqr(text, text, text, text) from public, anon;
grant execute on function public.ql_submit_khqr(text, text, text, text) to authenticated;

-- the admin notification also shows the bill number
create or replace function public.ql__push_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_plan text;
begin
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)) into v_name from auth.users where id = new.user_id;
  select name into v_plan from ql_plans where id = new.plan_id;
  perform ql__push(case when new.method = 'khqr' then '💳 New KHQR payment' else '💳 New payment receipt' end,
                   coalesce(v_name, 'A student') || ' · ' || coalesce(v_plan, new.plan_id) || ' · $' || coalesce(new.amount::text, '?')
                     || case when new.bill is not null then ' · ' || new.bill else '' end,
                   'admin.html#review', 'ql-pay');
  return new;
exception when undefined_function then
  return new;
end;
$$;

notify pgrst, 'reload schema';
