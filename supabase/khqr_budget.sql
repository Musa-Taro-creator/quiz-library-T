-- Quiz Library — KHQR auto-check: fit Bakong's free limit (100 checks a day).
-- The phone needs to know which payments are "I paid" (checked at once) and which
-- are only shown QRs (checked less often). When the phone reports a problem (for
-- example the daily limit is used up), students see the "I paid" button at once.
-- Run once AFTER khqr_auto_detect.sql. Safe to run again.

create or replace function public.ql_khqr_pending(p_secret text, p_note text default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not ql__khqr_ok(p_secret) then raise exception 'Wrong secret key' using errcode = '28000'; end if;
  update ql_khqr_checker set last_seen = now(), last_note = left(p_note, 200), device = coalesce(left(p_device, 80), device) where id = 1;
  return jsonb_build_object(
    'bakong_id', (select value->>'bakong_id' from ql_site_settings where key = 'payment'),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'md5', khqr_md5, 'amount', amount, 'bill', bill,
                                                             'status', status, 'created_at', created_at) order by created_at)
                           from ql_payment_requests
                          where method = 'khqr' and khqr_md5 is not null
                            and ((status = 'waiting' and created_at > now() - interval '2 days')
                              or (status in ('qr', 'expired') and created_at > now() - interval '3 hours'))), '[]'::jsonb));
end;
$$;

create or replace function public.ql_khqr_auto_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select secret is not null and last_seen > now() - interval '2 minutes' and coalesce(last_note, 'ok') = 'ok'
                     from ql_khqr_checker where id = 1), false);
$$;

notify pgrst, 'reload schema';
