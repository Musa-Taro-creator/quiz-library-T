-- Quiz Library — KHQR without "I paid": the payment is found by itself.
-- When a student opens the KHQR, it is saved as status 'qr' (not shown in admin
-- Payments). The Android phone auto-check looks for it too, and when Bakong says it
-- was paid the plan switches on and the student's screen updates by itself.
-- Unpaid QRs become 'expired'. "I paid" still exists as a backup (turns it into
-- 'waiting' for the admin).
-- Run once AFTER khqr_payment.sql and khqr_autocheck.sql. Safe to run again.

-- check a KHQR the student's app made; returns the price
create or replace function public.ql__khqr_amount(p_plan text, p_period text, p_qr text)
returns numeric language plpgsql stable security definer set search_path = public as $$
declare v_p ql_plans; v_amount numeric;
  v_acc text := lower(trim(coalesce((select value->>'bakong_id' from ql_site_settings where key = 'payment'), '')));
begin
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
  return v_amount;
end;
$$;
revoke all on function public.ql__khqr_amount(text, text, text) from public, anon, authenticated;

-- student: a KHQR is shown on screen
create or replace function public.ql_khqr_open(p_plan text, p_period text, p_qr text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_amount numeric; v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  v_amount := ql__khqr_amount(p_plan, p_period, p_qr);
  if (select count(*) from ql_payment_requests where user_id = v_uid and method = 'khqr' and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'Too many QR codes. Please wait a few minutes.';
  end if;
  update ql_payment_requests set status = 'expired' where user_id = v_uid and status = 'qr';
  insert into ql_payment_requests (user_id, plan_id, period, amount, status, method, bill, khqr, khqr_md5)
  values (v_uid, p_plan, p_period, v_amount, 'qr', 'khqr', left(ql__khqr_tag(p_qr, '62', '01'), 25), p_qr, md5(p_qr))
  on conflict do nothing
  returning id into v_id;
  if v_id is null then raise exception 'Please open the payment again.'; end if;
  return v_id;
end;
$$;
revoke all on function public.ql_khqr_open(text, text, text) from public, anon;
grant execute on function public.ql_khqr_open(text, text, text) to authenticated;

-- student: has my QR been paid yet?
create or replace function public.ql_khqr_state(p_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select status from ql_payment_requests where id = p_id and user_id = auth.uid();
$$;
revoke all on function public.ql_khqr_state(uuid) from public, anon;
grant execute on function public.ql_khqr_state(uuid) to authenticated;

-- student: is the automatic check running right now?
create or replace function public.ql_khqr_auto_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select secret is not null and last_seen > now() - interval '2 minutes' from ql_khqr_checker where id = 1), false);
$$;
revoke all on function public.ql_khqr_auto_on() from public, anon;
grant execute on function public.ql_khqr_auto_on() to authenticated;

-- student (backup): "I paid but it didn't switch on" → the admin checks it
create or replace function public.ql_khqr_i_paid(p_id uuid, p_receipt text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); r ql_payment_requests;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into r from ql_payment_requests where id = p_id and user_id = v_uid for update;
  if r.id is null then raise exception 'Please open the payment again.'; end if;
  if r.status = 'approved' then return; end if;
  if r.status = 'waiting' then raise exception 'This payment was already sent.'; end if;
  if r.status not in ('qr', 'expired') then raise exception 'Please open the payment again.'; end if;
  if p_receipt is not null and (left(p_receipt, 11) <> 'data:image/' or length(p_receipt) > 1500000) then
    raise exception 'The receipt photo is too large.';
  end if;
  if (select count(*) from ql_payment_requests where user_id = v_uid and status = 'waiting') >= 3 then
    raise exception 'You already have payments waiting for approval.';
  end if;
  update ql_payment_requests set status = 'waiting', created_at = now(), receipt = coalesce(nullif(p_receipt, ''), receipt) where id = p_id;
end;
$$;
revoke all on function public.ql_khqr_i_paid(uuid, text) from public, anon;
grant execute on function public.ql_khqr_i_paid(uuid, text) to authenticated;

-- the phone also looks at QRs that are on screen (or were, in the last 3 hours)
create or replace function public.ql_khqr_pending(p_secret text, p_note text default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not ql__khqr_ok(p_secret) then raise exception 'Wrong secret key' using errcode = '28000'; end if;
  update ql_khqr_checker set last_seen = now(), last_note = left(p_note, 200), device = coalesce(left(p_device, 80), device) where id = 1;
  return jsonb_build_object(
    'bakong_id', (select value->>'bakong_id' from ql_site_settings where key = 'payment'),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'md5', khqr_md5, 'amount', amount, 'bill', bill, 'created_at', created_at) order by created_at)
                           from ql_payment_requests
                          where method = 'khqr' and khqr_md5 is not null
                            and ((status = 'waiting' and created_at > now() - interval '2 days')
                              or (status in ('qr', 'expired') and created_at > now() - interval '3 hours'))), '[]'::jsonb));
end;
$$;

create or replace function public.ql_khqr_confirm(p_secret text, p_id uuid, p_hash text, p_amount numeric, p_currency text, p_to text, p_from text default null)
returns text language plpgsql security definer set search_path = public as $$
declare r ql_payment_requests; v_acc text;
begin
  if not ql__khqr_ok(p_secret) then raise exception 'Wrong secret key' using errcode = '28000'; end if;
  select * into r from ql_payment_requests where id = p_id for update;
  if r.id is null or r.status not in ('waiting', 'qr', 'expired') or r.method <> 'khqr' then return 'skip'; end if;
  v_acc := lower(trim(coalesce((select value->>'bakong_id' from ql_site_settings where key = 'payment'), '')));
  if coalesce(p_hash, '') = '' or lower(trim(coalesce(p_to, ''))) <> v_acc or upper(coalesce(p_currency, '')) <> 'USD'
     or coalesce(p_amount, 0) + 0.001 < r.amount then
    update ql_payment_requests set status = 'waiting',
           admin_note = left('Auto-check: Bakong shows ' || coalesce(p_amount::text, '?') || ' ' || coalesce(p_currency, '')
                             || ' to ' || coalesce(p_to, '?') || ' — please check', 200) where id = p_id;
    return 'mismatch';
  end if;
  if exists (select 1 from ql_payment_requests where bakong_hash = p_hash) then return 'used'; end if;
  update ql_payment_requests set status = 'approved', decided_at = now(), bakong_hash = p_hash,
         admin_note = left('⚡ Paid via Bakong' || coalesce(' from ' || nullif(p_from, ''), ''), 200)
   where id = p_id;
  perform ql__grant(r.user_id, r.plan_id, case r.period when 'month' then 30 when 'year' then 365 else null end);
  update ql_khqr_checker set approved = approved + 1 where id = 1;
  return 'approved';
end;
$$;

-- admin notifications: a receipt / "I paid" waiting for you, or money that arrived by itself
create or replace function public.ql__push_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_name text; v_plan text; v_what text;
begin
  if tg_op = 'INSERT' and new.status = 'waiting' then
    v_what := case when new.method = 'khqr' then '💳 New KHQR payment' else '💳 New payment receipt' end;
  elsif tg_op = 'UPDATE' and new.status = 'waiting' and old.status in ('qr', 'expired') then
    v_what := '💳 KHQR payment to check';
  elsif tg_op = 'UPDATE' and new.status = 'approved' and old.status <> 'approved' and new.bakong_hash is not null then
    v_what := '💰 Paid by KHQR — plan is on';
  else
    return new;
  end if;
  select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)) into v_name from auth.users where id = new.user_id;
  select name into v_plan from ql_plans where id = new.plan_id;
  perform ql__push(v_what,
                   coalesce(v_name, 'A student') || ' · ' || coalesce(v_plan, new.plan_id) || ' · $' || coalesce(new.amount::text, '?')
                     || case when new.bill is not null then ' · ' || new.bill else '' end,
                   case when new.status = 'approved' then 'admin.html#pay' else 'admin.html#review' end, 'ql-pay-' || new.id);
  return new;
exception when undefined_function then
  return new;
end;
$$;
do $$
begin
  if to_regclass('public.ql_push_config') is not null then
    drop trigger if exists ql_push_on_payment on public.ql_payment_requests;
    create trigger ql_push_on_payment after insert or update of status on public.ql_payment_requests
      for each row execute function public.ql__push_on_payment();
  end if;
end $$;

notify pgrst, 'reload schema';
