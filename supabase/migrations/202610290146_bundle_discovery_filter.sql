-- Apply after 145, before deploying Bundle: All / Yes / No.
-- Read-only filter; existing reader signatures and all writes remain unchanged.
begin;
do $patch$
declare body text;
    anchor text := 'from public.auctions a'||E'\n    where';
begin
    select prosrc into body from pg_proc
        where oid='public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text)'::regprocedure;
    if strpos(body,anchor)=0 then raise exception 'Unexpected auction reader; inspect before applying 146.'; end if;
    body:=replace(body,anchor,anchor||$filter$
        (case p_bundle when 'any' then true
            when 'with' then jsonb_array_length(coalesce(a.bundle_items,'[]'::jsonb))>1
            when 'without' then jsonb_array_length(coalesce(a.bundle_items,'[]'::jsonb))<=1
            else false end) and$filter$);
    execute 'create or replace function public.read_filtered_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text,p_kind text,p_min_price numeric,p_max_price numeric,p_buyout text,p_bundle text)'
        ||' returns jsonb language sql stable security definer set search_path='''' as '||quote_literal(body);
end; $patch$;
revoke all on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text) from public,anon,authenticated,service_role;
grant execute on function public.read_filtered_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
