-- Apply after 179, before deploying website/cache changes. Display-only.
-- No financial definitions, locks, authorization or settlement rules change.
begin;
set local lock_timeout='2s';

-- A complete quote is required: never call a partially priced bundle a bargain.
create function khub_bot.deal_quote(a public.auctions)
returns table(value numeric, checked_at timestamptz)
language sql stable set search_path='' as $$
 select case when bool_and(coalesce(c.is_current and c.tradeable and m.available and m.price_meat>0,false))
   then sum(m.price_meat::numeric*(x->>'quantity')::bigint) end, min(m.checked_at)
 from jsonb_array_elements(case when a.auction_kind='buy'
   then jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',1)) else khub_bot.auction_items(a) end) x
 left join khub_bot.catalog c on c.id=(x->>'id')::integer
 left join khub_bot.market_prices m on m.item_id=c.id;
$$;
create function khub_bot.deal_score(a public.auctions) returns numeric
language sql stable set search_path='' as $$
 with quote as (select * from khub_bot.deal_quote(a)), saving as (
   select value, case when a.auction_kind='buy' then a.min_bid_meat::numeric-value
   else value-least(khub_bot.minimum_auction_bid(a.min_bid_meat,a.current_bid)::numeric,
       case when a.instant_purchase_price>a.current_bid and a.instant_purchase_price>=a.min_bid_meat
            then a.instant_purchase_price::numeric else 9007199254740991::numeric end) end as amount
   from quote where value>0 and checked_at>statement_timestamp()-interval '24 hours' and checked_at<=statement_timestamp()
 ) select coalesce((select amount/value from saving where amount>=10000 and amount/value>=0.05
   and a.giveaway_title is null and a.status='active'
   and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()),0);
$$;
create function khub_bot.deal_projection(a public.auctions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('deal_market_value_meat',value::text,'deal_checked_at',checked_at) from khub_bot.deal_quote(a);
$$;
revoke all on function khub_bot.deal_quote(public.auctions),khub_bot.deal_score(public.auctions),khub_bot.deal_projection(public.auctions) from public,anon,authenticated,service_role;

-- Preserve the complete matching pool and existing visibility predicates. Rank
-- before pagination; compute a score once per matching row only for these sorts.
do $patch$
declare f record; d text; patched integer:=0;
 anchor text:='select m.* from matching m order by';
 ordering text:=$order$
        case when p_sort in ('recommended','best-value') then
          (m.giveaway_title is not null and m.status='active' and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp())::integer end desc,
        case when p_sort='recommended' then case when m.status='active'
          and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
          and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '3 hours' then 0 else 1 end end,
        case when p_sort='recommended' and m.status='active'
          and coalesce(m.escrow_buyout_received_at,m.end_time)>statement_timestamp()
          and coalesce(m.escrow_buyout_received_at,m.end_time)<=statement_timestamp()+interval '3 hours'
          then coalesce(m.escrow_buyout_received_at,m.end_time) end,
        case when p_sort in ('recommended','best-value') then m.deal_score end desc,
        case when p_sort in ('recommended','best-value') and m.deal_score>0 then coalesce(m.escrow_buyout_received_at,m.end_time) end,
$order$;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.prokind='f' and ((n.nspname='public' and p.proname in('read_auction_page','read_filtered_auction_page'))
 or (n.nspname='khub_bot' and p.proname='public_listing_page')) loop
   d:=pg_get_functiondef(f.oid);
   if strpos(d,anchor)=0 then continue; end if; -- delegating overloads
   if strpos(d,'select a.*,')=0 then raise exception 'Unexpected matching pool in %',f.oid::regprocedure;end if;
   d:=replace(d,'select a.*,','select a.*, case when p_sort in (''recommended'',''best-value'') then khub_bot.deal_score(a) else 0 end as deal_score,');
   -- Remove the original recommended block, retaining every explicit sort.
   d:=regexp_replace(d,'/\* red_time_recommended_v1 \*/ case when p_sort=''recommended''.*?case when p_sort=''recommended'' then m.created_at end desc,','','s');
   if strpos(d,'red_time_recommended_v1')>0 then raise exception 'Unrecognized Discover sort';end if;
   d:=replace(d,anchor,anchor||ordering);
   execute d; patched:=patched+1;
 end loop;
 if patched<4 then raise exception 'Expected at least four bounded readers, found %',patched;end if;
end;$patch$;

-- Keep the existing "popular" section key for transport compatibility; it now
-- selects Hidden Gems, with the best representative per item and a 24-card bound.
do $patch$
declare d text;
begin
 d:=pg_get_functiondef('public.read_home_auctions_before_site_totals()'::regprocedure);
 if strpos(d,'as popular_rank')=0 then raise exception 'Unexpected Home sections';end if;
 d:=replace(d,'select a.id,a.item_id,a.item,a.created_at,',
 'select a.id,a.item_id,a.item,a.created_at,a.giveaway_title is not null as giveaway,khub_bot.deal_score(a) as deal_score,');
 d:=replace(d,'order by bid_count desc,created_at desc,id) as popular_rank',
 'order by giveaway desc,deal_score desc,deadline,created_at desc,id) as popular_rank');
 d:=replace(d,'select id,row_number() over(order by bid_count desc,created_at desc,id) as ordinal from ranked',
 'select id,row_number() over(order by giveaway desc,deal_score desc,deadline,created_at desc,id) as ordinal from ranked');
 d:=replace(d,'where popular_rank=1 order by bid_count desc,created_at desc,id limit 24',
 'where popular_rank=1 and (giveaway or deal_score>0) order by giveaway desc,deal_score desc,deadline,created_at desc,id limit 24');
 execute d;
end;$patch$;

-- Add only public quote facts to existing listing projections. This covers both
-- direct readers and shared readers without touching private overlay permissions.
do $patch$
declare f record; d text; patched integer:=0;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.prokind='f' and n.nspname in('public','khub_bot')
 and (p.proname like 'read_%' or p.proname='public_listing_page')
 and strpos(p.prosrc,'''market_value_meat'',')>0 loop
   d:=pg_get_functiondef(f.oid);
   d:=replace(d,'jsonb_build_object(''market_value_meat'',','khub_bot.deal_projection(a)||jsonb_build_object(''market_value_meat'',');
   execute d;patched:=patched+1;
 end loop;
 if patched<4 then raise exception 'Expected quote projections, found %',patched;end if;
end;$patch$;
notify pgrst,'reload schema';
commit;
