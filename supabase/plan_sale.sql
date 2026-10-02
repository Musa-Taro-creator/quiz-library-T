-- Quiz Library — plan sale (discount). The admin sets "% off" (and an optional end date)
-- in Plans & Limits → Edit → Discount; it is saved in the plan as features._sale.
-- This makes the payment amount use the sale price too.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql. Safe to run again.

create or replace function public.ql__plan_price(p ql_plans, p_period text)
returns numeric language plpgsql stable as $$
declare v numeric; v_pct numeric; v_until timestamptz;
begin
  v := case p_period when 'month' then p.price_month when 'year' then p.price_year when 'lifetime' then p.price_lifetime end;
  if v is null then return null; end if;
  if jsonb_typeof(p.features->'_sale') = 'object' then
    v_pct := nullif(p.features->'_sale'->>'pct', '')::numeric;
    v_until := nullif(p.features->'_sale'->>'until', '')::timestamptz;
    if v_pct > 0 and v_pct <= 90 and (v_until is null or v_until > now()) then
      v := round(v * (100 - v_pct) / 100, 2);
    end if;
  end if;
  return v;
end;
$$;

create or replace function public.ql_submit_payment(p_plan text, p_period text, p_receipt text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_p ql_plans;
  v_amount numeric;
  v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  select * into v_p from ql_plans where id = p_plan and visibility = 'public';
  if v_p.id is null then raise exception 'That plan is not available.'; end if;
  v_amount := ql__plan_price(v_p, p_period);
  if v_amount is null then raise exception 'That payment option is not available.'; end if;
  if length(coalesce(p_receipt, '')) < 100 then raise exception 'Please add a photo of your receipt.'; end if;
  if length(p_receipt) > 1500000 then raise exception 'The receipt photo is too large.'; end if;
  if (select count(*) from ql_payment_requests where user_id = v_uid and status = 'waiting') >= 3 then
    raise exception 'You already have payments waiting for approval.';
  end if;
  insert into ql_payment_requests (user_id, plan_id, period, amount, receipt)
  values (v_uid, p_plan, p_period, v_amount, p_receipt) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.ql_submit_payment(text, text, text) from public, anon;
grant execute on function public.ql_submit_payment(text, text, text) to authenticated;

notify pgrst, 'reload schema';
