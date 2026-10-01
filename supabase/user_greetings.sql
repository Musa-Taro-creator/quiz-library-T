-- Quiz Library — a personal greeting for one user (admin → Users → Manage).
-- It replaces the normal greeting for that person. Safe to run again.

create table if not exists public.ql_user_greetings (
  user_id    uuid primary key,
  greeting   text not null default '',
  note       text not null default '',
  off        boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.ql_user_greetings enable row level security;
revoke all on public.ql_user_greetings from anon, authenticated;

create or replace function public.ql_admin_get_greeting(p_user uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform ql__need_admin();
  return (select to_jsonb(g) from ql_user_greetings g where g.user_id = p_user);
end;
$$;
revoke all on function public.ql_admin_get_greeting(uuid) from public, anon;
grant execute on function public.ql_admin_get_greeting(uuid) to authenticated;

-- empty greeting + empty note + not off = remove the personal greeting
create or replace function public.ql_admin_set_greeting(p_user uuid, p_greeting text, p_note text, p_off boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform ql__need_admin();
  if coalesce(trim(p_greeting), '') = '' and coalesce(trim(p_note), '') = '' and not coalesce(p_off, false) then
    delete from ql_user_greetings where user_id = p_user;
  else
    insert into ql_user_greetings (user_id, greeting, note, off, updated_at)
    values (p_user, left(coalesce(p_greeting, ''), 80), left(coalesce(p_note, ''), 160), coalesce(p_off, false), now())
    on conflict (user_id) do update set greeting = excluded.greeting, note = excluded.note, off = excluded.off, updated_at = now();
  end if;
end;
$$;
revoke all on function public.ql_admin_set_greeting(uuid, text, text, boolean) from public, anon;
grant execute on function public.ql_admin_set_greeting(uuid, text, text, boolean) to authenticated;

create or replace function public.ql_my_greeting()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('greeting', greeting, 'note', note, 'off', off) from ql_user_greetings where user_id = auth.uid();
$$;
revoke all on function public.ql_my_greeting() from public, anon;
grant execute on function public.ql_my_greeting() to authenticated;

notify pgrst, 'reload schema';
