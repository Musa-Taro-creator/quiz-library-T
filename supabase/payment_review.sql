-- Quiz Library — fast receipt review: warnings for a reused receipt photo and
-- for a student with more than one receipt waiting. Notifications for new
-- receipts now open the review window directly.
-- Run once in Supabase → SQL Editor, AFTER plans_admin.sql (and admin_push.sql if you use notifications).
-- Safe to run again.

create or replace function public.ql_admin_payment_checks(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r ql_payment_requests; v_hash text;
begin
  perform ql__need_admin();
  select * into r from ql_payment_requests where id = p_id;
  if r.id is null then return null; end if;
  v_hash := md5(coalesce(r.receipt, ''));
  return jsonb_build_object(
    'same_photo', (select count(*) from ql_payment_requests x where x.id <> r.id and x.receipt is not null and md5(x.receipt) = v_hash),
    'same_photo_approved', (select count(*) from ql_payment_requests x where x.id <> r.id and x.status = 'approved' and x.receipt is not null and md5(x.receipt) = v_hash),
    'other_waiting', (select count(*) from ql_payment_requests x where x.id <> r.id and x.user_id = r.user_id and x.status = 'waiting'),
    'paid_before', (select count(*) from ql_payment_requests x where x.user_id = r.user_id and x.status = 'approved'));
end;
$$;
revoke all on function public.ql_admin_payment_checks(uuid) from public, anon;
grant execute on function public.ql_admin_payment_checks(uuid) to authenticated;

-- the new-receipt notification opens the review window (only if notifications are set up)
do $$
begin
  if to_regprocedure('public.ql__push(text,text,text,text)') is not null then
    execute $f$
      create or replace function public.ql__push_on_payment()
      returns trigger language plpgsql security definer set search_path = public as $b$
      declare v_name text; v_plan text;
      begin
        select coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', split_part(email, '@', 1)) into v_name from auth.users where id = new.user_id;
        select name into v_plan from ql_plans where id = new.plan_id;
        perform ql__push('💳 New payment receipt',
                         coalesce(v_name, 'A student') || ' · ' || coalesce(v_plan, new.plan_id) || ' · $' || coalesce(new.amount::text, '?') || ' — tap to review',
                         'admin.html#review', 'ql-pay');
        return new;
      end;
      $b$;
    $f$;
  end if;
end $$;

notify pgrst, 'reload schema';
