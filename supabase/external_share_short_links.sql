-- Quiz Library — short links for "Share externally".
--
-- Run this once in Supabase → SQL Editor. It is safe to run again.
--
-- Adds a small "short link book": each row maps a short code (e.g. K7P2XQA)
-- to the long share code that already sits after ?quiz_share= in today's
-- links. Nothing existing is changed or deleted, and old long links keep
-- working. Links then look like:
--   https://musa-taro-creator.github.io/quiz-library-T/?s=K7P2XQA

create table if not exists public.ql_short_links (
  code        text        primary key,
  share_token text        not null,
  created_by  uuid        not null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists ql_short_links_by_owner
  on public.ql_short_links (created_by, share_token);

-- Row-level security: a signed-in account can only see its own rows; nobody
-- can list other people's codes. Looking one code up goes through
-- ql_resolve_short_link below.
alter table public.ql_short_links enable row level security;
drop policy if exists "own short links" on public.ql_short_links;
create policy "own short links" on public.ql_short_links
  for select to authenticated
  using (created_by = auth.uid());
revoke all on public.ql_short_links from anon, authenticated;
grant select on public.ql_short_links to authenticated;

-- Make (or reuse) a 7-character code for one of your share links.
-- Letters/digits that are easy to read: no 0/O, 1/I/L.
create or replace function public.ql_create_short_link(p_share_token text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_alphabet text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code     text;
  v_bytes    bytea;
  v_tries    integer := 0;
  i          integer;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_share_token), '') = '' then
    raise exception 'missing share token';
  end if;

  select code into v_code
    from ql_short_links
   where created_by = v_uid and share_token = p_share_token
   limit 1;
  if v_code is not null then
    return v_code;
  end if;

  loop
    v_bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    v_code := '';
    for i in 0..6 loop
      v_code := v_code || substr(v_alphabet, 1 + (get_byte(v_bytes, i) % length(v_alphabet)), 1);
    end loop;
    begin
      insert into ql_short_links (code, share_token, created_by)
      values (v_code, p_share_token, v_uid);
      return v_code;
    exception when unique_violation then
      v_tries := v_tries + 1;
      if v_tries > 20 then
        raise;
      end if;
    end;
  end loop;
end;
$$;
revoke all on function public.ql_create_short_link(text) from public, anon;
grant execute on function public.ql_create_short_link(text) to authenticated;

-- Turn one short code back into its share code (students have no account,
-- so anon may call this; it only ever answers for the exact code asked).
create or replace function public.ql_resolve_short_link(p_code text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select share_token
    from ql_short_links
   where code = upper(trim(p_code))
   limit 1;
$$;
revoke all on function public.ql_resolve_short_link(text) from public;
grant execute on function public.ql_resolve_short_link(text) to anon, authenticated;

-- Make the new table and functions visible to the API right away.
notify pgrst, 'reload schema';
