-- Quiz Library — security fixes (October 2026). Safe to run again.
-- Receipts must be real pictures. Before, anything long enough was accepted, so a
-- hacker could send a "javascript:" link instead of a photo and trick the admin page.

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
  if p_receipt !~ '^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$' then raise exception 'The receipt must be a photo.'; end if;
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

-- the same rule for KHQR receipts and Help & Support pictures
create or replace function public.ql__support_check(p_body text, p_image text)
returns void language plpgsql immutable as $$
begin
  if coalesce(trim(p_body), '') = '' and coalesce(p_image, '') = '' then raise exception 'Write a message first.'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'The message is too long (2000 characters max).'; end if;
  if p_image is not null and p_image <> '' and (p_image !~ '^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$' or length(p_image) > 900000) then
    raise exception 'The picture is too large or not an image.';
  end if;
end;
$$;

-- remove any bad receipts already saved (keeps the payment, drops the fake picture)
update public.ql_payment_requests set receipt = null
 where receipt is not null and receipt !~ '^data:image/(png|jpe?g|webp|gif);base64,';
update public.ql_support_msgs set image = null
 where image is not null and image !~ '^data:image/(png|jpe?g|webp|gif);base64,';

notify pgrst, 'reload schema';
