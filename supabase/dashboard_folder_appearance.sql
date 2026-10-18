-- Dashboard folder appearance: targeted update for an existing Dashboard setup.
-- Run in Supabase SQL Editor AFTER dashboard.sql has already been installed.
-- Replaces only ql_dash_list(); no table, saved-content, or policy changes.
-- Returns only root-folder color and icon, never the full sharing payload.
-- Safe to rerun. Older website versions ignore the new appearance field.

begin;

create or replace function public.ql_dash_list()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'item_count', item_count,
                 'author_name', author_name, 'created_at', created_at, 'opens', opens, 'appearance', case when kind = 'folder' then
                   (select jsonb_build_object('color', n->>'color', 'icon', n->>'icon')
                      from jsonb_array_elements(payload->'nodes') n
                     where n->>'ref' = payload->>'root_ref' limit 1) end,
                 'mine', owner_id = auth.uid()) order by decided_at desc nulls last, created_at desc)
               from ql_dash_posts where status = 'approved'), '[]'::jsonb),
    'mine', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'status', status, 'admin_note', admin_note, 'appearance', case when kind = 'folder' then
                   (select jsonb_build_object('color', n->>'color', 'icon', n->>'icon')
                      from jsonb_array_elements(payload->'nodes') n
                     where n->>'ref' = payload->>'root_ref' limit 1) end,
                 'created_at', created_at) order by created_at desc)
               from ql_dash_posts where owner_id = auth.uid() and status <> 'removed'), '[]'::jsonb),
    'can_save', ql__feature_ok(auth.uid(), 'dash_save'));
$$;
revoke all on function public.ql_dash_list() from public, anon;
grant execute on function public.ql_dash_list() to authenticated;

notify pgrst, 'reload schema';
commit;
