-- Quiz Library — security check (READ ONLY, changes nothing). Run in Supabase → SQL Editor.
-- Every row in the result is something to look at. An empty result = all good.
with
no_rls as (
  select 'Table WITHOUT protection (RLS off)' as problem, c.relname::text as name, '' as detail
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
),
open_write as (
  select 'Anyone (not signed in) can change this table' as problem, tablename::text,
         policyname || ' · ' || cmd
    from pg_policies
   where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     and (roles && array['anon','public']::name[])
),
open_all as (
  select 'Every signed-in user can change ALL rows (not only their own)', tablename::text,
         policyname || ' · ' || cmd
    from pg_policies
   where schemaname = 'public' and cmd in ('UPDATE', 'DELETE', 'ALL')
     and coalesce(qual, 'true') = 'true'
),
anon_read as (
  select 'Anyone can READ this table', tablename::text, policyname
    from pg_policies
   where schemaname = 'public' and cmd = 'SELECT' and (roles && array['anon','public']::name[])
     and tablename not in ('ql_plans', 'ql_site_settings')
),
buckets as (
  select 'Public file bucket (anyone with the link can download)', name::text, ''
    from storage.buckets where public
),
storage_open as (
  select 'File storage rule open to everyone', policyname::text, cmd
    from pg_policies
   where schemaname = 'storage' and (roles && array['anon','public']::name[]) and cmd <> 'SELECT'
)
select * from no_rls union all select * from open_write union all select * from open_all
union all select * from anon_read union all select * from buckets union all select * from storage_open
order by 1, 2;
