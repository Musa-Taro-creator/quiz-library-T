-- Quiz Library — automatic KHQR check with an Android phone (Termux).
-- Bakong only answers apps inside Cambodia, so a small script on the admin's phone
-- asks Supabase for waiting KHQR payments, asks Bakong if each QR was paid, and
-- reports back here. The plan switches on when Bakong confirms the right amount
-- went to the admin's Bakong ID.
-- The phone uses a secret key (admin → Settings → KHQR → Auto-check). The Bakong
-- token stays on the phone only. Run once AFTER khqr_payment.sql. Safe to run again.

alter table public.ql_payment_requests add column if not exists bakong_hash text;   -- Bakong transaction id
create unique index if not exists ql_payment_requests_bakong_hash on public.ql_payment_requests (bakong_hash) where bakong_hash is not null;

create table if not exists public.ql_khqr_checker (
  id         integer primary key default 1 check (id = 1),
  secret     text,
  last_seen  timestamptz,
  last_note  text,
  device     text,
  approved   integer not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ql_khqr_checker enable row level security;
revoke all on public.ql_khqr_checker from anon, authenticated;

-- admin: status of the phone
create or replace function public.ql_admin_khqr_checker()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c ql_khqr_checker;
begin
  perform ql__need_admin();
  select * into c from ql_khqr_checker where id = 1;
  return jsonb_build_object('has_secret', c.secret is not null, 'last_seen', c.last_seen, 'last_note', c.last_note,
                            'device', c.device, 'approved', coalesce(c.approved, 0), 'now', now());
end;
$$;
revoke all on function public.ql_admin_khqr_checker() from public, anon;
grant execute on function public.ql_admin_khqr_checker() to authenticated;

-- admin: make a (new) secret key — the old phone stops working at once
create or replace function public.ql_admin_khqr_new_secret()
returns text language plpgsql security definer set search_path = public as $$
declare v text := 'qlk_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  perform ql__need_admin();
  insert into ql_khqr_checker (id, secret, updated_at) values (1, v, now())
  on conflict (id) do update set secret = excluded.secret, last_seen = null, last_note = null, device = null, updated_at = now();
  return v;
end;
$$;
revoke all on function public.ql_admin_khqr_new_secret() from public, anon;
grant execute on function public.ql_admin_khqr_new_secret() to authenticated;

create or replace function public.ql__khqr_ok(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from ql_khqr_checker where id = 1 and secret is not null and secret = p_secret);
$$;
revoke all on function public.ql__khqr_ok(text) from public, anon, authenticated;

-- phone: which KHQR payments are waiting? (also says "I'm online")
create or replace function public.ql_khqr_pending(p_secret text, p_note text default null, p_device text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not ql__khqr_ok(p_secret) then raise exception 'Wrong secret key' using errcode = '28000'; end if;
  update ql_khqr_checker set last_seen = now(), last_note = left(p_note, 200), device = coalesce(left(p_device, 80), device) where id = 1;
  return jsonb_build_object(
    'bakong_id', (select value->>'bakong_id' from ql_site_settings where key = 'payment'),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'md5', khqr_md5, 'amount', amount, 'bill', bill, 'created_at', created_at) order by created_at)
                           from ql_payment_requests
                          where status = 'waiting' and method = 'khqr' and khqr_md5 is not null and created_at > now() - interval '2 days'), '[]'::jsonb));
end;
$$;
revoke all on function public.ql_khqr_pending(text, text, text) from public;
grant execute on function public.ql_khqr_pending(text, text, text) to anon, authenticated;

-- phone: Bakong says this QR was paid → check it and switch the plan on
create or replace function public.ql_khqr_confirm(p_secret text, p_id uuid, p_hash text, p_amount numeric, p_currency text, p_to text, p_from text default null)
returns text language plpgsql security definer set search_path = public as $$
declare r ql_payment_requests; v_acc text;
begin
  if not ql__khqr_ok(p_secret) then raise exception 'Wrong secret key' using errcode = '28000'; end if;
  select * into r from ql_payment_requests where id = p_id for update;
  if r.id is null or r.status <> 'waiting' or r.method <> 'khqr' then return 'skip'; end if;
  v_acc := lower(trim(coalesce((select value->>'bakong_id' from ql_site_settings where key = 'payment'), '')));
  if coalesce(p_hash, '') = '' or lower(trim(coalesce(p_to, ''))) <> v_acc or upper(coalesce(p_currency, '')) <> 'USD'
     or coalesce(p_amount, 0) + 0.001 < r.amount then
    update ql_payment_requests set admin_note = left('Auto-check: Bakong shows ' || coalesce(p_amount::text, '?') || ' ' || coalesce(p_currency, '')
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
revoke all on function public.ql_khqr_confirm(text, uuid, text, numeric, text, text, text) from public;
grant execute on function public.ql_khqr_confirm(text, uuid, text, numeric, text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
