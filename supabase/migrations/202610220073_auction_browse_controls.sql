-- Apply after 072, before deploying the website. Read-only browsing changes.
begin;
select pg_advisory_xact_lock(3888760);

do $$
declare
    body text;
    signature text := 'p_view text default ''browse'', p_id uuid default null, p_search text default '''', p_status text default ''active'', p_sort text default ''ending'', p_page integer default 1';
    count_anchor text := '(select count(*) from public.bids b where b.auction_id=a.id) as bid_count';
    sort_anchor text := 'select m.* from matching m order by';
    filter_anchor text := 'from public.auctions a' || E'\n    where';
    row_anchor text := 'khub_bot.public_auction(a,p.bid_count,h.label,w.label)';
begin
    select prosrc into body from pg_proc where oid='public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure;
    if strpos(body,count_anchor)=0 or strpos(body,sort_anchor)=0 or strpos(body,filter_anchor)=0 or strpos(body,row_anchor)=0 then
        raise exception 'Unexpected auction reader; browse-controls migration not applied.';
    end if;
    body:=replace(body,count_anchor,count_anchor || ', (select max(b.created_at) from public.bids b where b.auction_id=a.id) as latest_bid_at');
    body:=replace(body,sort_anchor,sort_anchor || E'\n        case when p_sort=''bids-desc'' then m.bid_count end desc,\n        case when p_sort=''bids-asc'' then m.bid_count end asc,\n        case when p_sort=''activity'' then m.latest_bid_at end desc nulls last,');
    body:=replace(body,row_anchor,row_anchor || '||jsonb_build_object(''latest_bid_at'',p.latest_bid_at)');
    -- Keep the six-argument API and its privacy wrappers for existing callers.
    execute 'create or replace function public.read_auction_page(' || signature || ') returns jsonb language sql stable security definer set search_path='''' as ' || quote_literal(body);
    -- Explicit seven-argument overload: filtering happens in matching, before
    -- counting, sorting and LIMIT/OFFSET. No defaults means no ambiguous calls.
    body:=replace(body,filter_anchor,filter_anchor || E' (p_trade=''all'' or (p_trade=''escrow'' and a.escrow_mode) or (p_trade=''direct'' and not a.escrow_mode)) and');
    execute 'create function public.read_auction_page(p_view text,p_id uuid,p_search text,p_status text,p_sort text,p_page integer,p_trade text) returns jsonb language sql stable security definer set search_path='''' as ' || quote_literal(body);
end; $$;
revoke all on function public.read_auction_page(text,uuid,text,text,text,integer,text) from public;
grant execute on function public.read_auction_page(text,uuid,text,text,text,integer,text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
