-- Quiz Library — stop the device check from writing on every call.
--
-- ql_device_check runs every 45 s in each open tab. It wrote "last seen = now" to
-- ql_signed_devices and ql_device_log on EVERY call. ql_signed_devices sends live
-- updates (Realtime) to the app, and the app answered each update with another
-- ql_device_check, which wrote again: every open tab checked non-stop. Tabs of the same
-- account then waited on each other's row locks until "canceling statement due to
-- statement timeout", and the whole site became slow ("Loading…").
--
-- Now "last seen" is written at most once every 5 minutes, so a check normally only
-- reads. This also stops the loop in apps that still run the old website code.
-- Blocked devices and the device limit work exactly as before.
--
-- Run once in Supabase → SQL Editor, AFTER multi_device.sql. Safe to run again.

create or replace function public.ql_device_check(p_device_id text, p_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '28000'; end if;
  if coalesce(trim(p_device_id), '') = '' then raise exception 'missing device id'; end if;
  -- a blocked device is refused (as ql_touch_device does)
  if exists (select 1 from ql_device_log where user_id = v_uid and device_id = p_device_id and blocked) then
    raise exception 'device_blocked' using errcode = '42501';
  end if;
  -- device history: write only when this device was not seen in the last 5 minutes
  if not exists (select 1 from ql_device_log
                  where user_id = v_uid and device_id = p_device_id
                    and last_seen > now() - interval '5 minutes') then
    perform ql_touch_device(p_device_id, p_label);
  end if;
  -- signed-in device: same rule (an UPDATE that changes no row sends no live update)
  update ql_signed_devices set last_seen = now()
   where user_id = v_uid and device_id = p_device_id
     and last_seen < now() - interval '5 minutes';
  -- remove extra devices only when the account is over its limit
  if ql__device_limit(v_uid) is not null
     and (select count(*) from ql_signed_devices where user_id = v_uid) > ql__device_limit(v_uid) then
    perform ql__trim_devices(v_uid, null);
  end if;
  return ql__my_devices_info(v_uid, p_device_id);
end;
$$;
revoke all on function public.ql_device_check(text, text) from public, anon;
grant execute on function public.ql_device_check(text, text) to authenticated;

notify pgrst, 'reload schema';
