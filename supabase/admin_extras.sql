-- Quiz Library — admin extras: Supabase storage on the Dashboard and
-- permanently deleting a user. Run once in Supabase → SQL Editor, AFTER
-- plans_admin.sql. Safe to run again.

-- Your Supabase plan's limits (change them in admin → Settings when you
-- upgrade Supabase). Free plan: 1 GB files, 500 MB database.
insert into public.ql_site_settings (key, value) values
 ('supabase', '{"files_mb":1024,"db_mb":500,"warn_percent":90}')
on conflict (key) do nothing;

create or replace function public.ql_admin_set_setting(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if p_key not in ('site', 'features', 'announcement', 'payment', 'supabase') then raise exception 'Unknown setting'; end if;
  insert into ql_site_settings (key, value, updated_at) values (p_key, coalesce(p_value, '{}'::jsonb), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;
revoke all on function public.ql_admin_set_setting(text, jsonb) from public, anon;
grant execute on function public.ql_admin_set_setting(text, jsonb) to authenticated;

-- How full Supabase is right now.
create or replace function public.ql_admin_storage()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v jsonb;
begin
  perform ql__need_admin();
  select jsonb_build_object(
    'files_bytes', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where (metadata->>'size') ~ '^[0-9]+$'),
    'files_count', (select count(*) from storage.objects),
    'db_bytes', pg_database_size(current_database()),
    'limits', coalesce((select value from ql_site_settings where key = 'supabase'), '{"files_mb":1024,"db_mb":500,"warn_percent":90}'::jsonb)
  ) into v;
  return v;
end;
$$;
revoke all on function public.ql_admin_storage() from public, anon;
grant execute on function public.ql_admin_storage() to authenticated;

-- Permanently delete an account and everything it owns.
-- p_email must be typed again as a safety check. Admin accounts cannot be deleted.
create or replace function public.ql_admin_delete_user(p_user uuid, p_email text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_files int := 0;
  v_left int := 0;
  t text;
begin
  perform ql__need_admin();
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'User not found'; end if;
  if lower(v_email) <> lower(trim(coalesce(p_email, ''))) then raise exception 'The email you typed does not match this account'; end if;
  if p_user = auth.uid() or ql__is_admin(p_user) then raise exception 'Admin accounts cannot be deleted here'; end if;

  -- PDF files in storage
  begin
    delete from storage.objects where name like 'students/' || p_user::text || '/%' or owner = p_user;
    get diagnostics v_files = row_count;
  exception when others then
    v_files := 0;
  end;
  select count(*) into v_left from storage.objects where name like 'students/' || p_user::text || '/%' or owner = p_user;

  -- everything stored for this account
  foreach t in array array['student_library_items', 'ql_subscriptions', 'ql_code_redemptions', 'ql_payment_requests',
                           'ql_active_device', 'ql_device_log', 'student_share_profiles'] loop
    if to_regclass('public.' || t) is not null then
      begin
        execute format('delete from public.%I where user_id = $1', t) using p_user;
      exception when undefined_column then null;
      end;
    end if;
  end loop;
  if to_regclass('public.ql_item_shares') is not null then
    delete from ql_item_shares where sender_id = p_user or recipient_id = p_user;
  end if;
  if to_regclass('public.ql_external_item_shares') is not null then
    delete from ql_external_item_shares where owner_id = p_user;
  end if;
  if to_regclass('public.ql_short_links') is not null then
    delete from ql_short_links where created_by = p_user;
  end if;

  -- the login itself
  delete from auth.users where id = p_user;

  return jsonb_build_object('email', v_email, 'files_deleted', v_files, 'files_left', v_left,
                            'folder', 'students/' || p_user::text || '/');
end;
$$;
revoke all on function public.ql_admin_delete_user(uuid, text) from public, anon;
grant execute on function public.ql_admin_delete_user(uuid, text) to authenticated;

notify pgrst, 'reload schema';
