-- After 257. Read-only Home discovery; no financial or visibility rules change.
-- Apply once, then deploy website and the separate public-cache Worker.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text; start_at integer; end_at integer;
begin
 source:=pg_get_functiondef('khub_bot.home_cards_core()'::regprocedure);
 if strpos(source,'where popular_rank=1 and (giveaway or deal_score>0)')=0
 or strpos(source,'from active')=0 then
   raise exception 'Unexpected Home selection; inspect installed definition';
 end if;
 source:=replace(source,'select a.id,a.item_id,a.item,a.created_at,','select a.id,a.item_id,a.item,a.created_at,a.auction_kind,a.escrow_mode,');
 source:=replace(source,'partition by case when item_id','partition by explore_type,case when item_id');
 source:=replace(source,'from active'||chr(10)||'), popular as materialized (',
 'from active cross join (values (''all''),(''buy''),(''direct''),(''escrow'')) types(explore_type)
 where explore_type=''all'' or case when auction_kind=''buy'' then explore_type=''buy'' when escrow_mode then explore_type=''escrow'' else explore_type=''direct'' end
), popular as materialized (');
 if strpos(source,'types(explore_type)')=0 then raise exception 'Unexpected active pool'; end if;
 start_at:=strpos(source,'popular as materialized (');
 end_at:=strpos(source,'high_candidates as materialized (');
 if start_at=0 or end_at<=start_at then raise exception 'Unexpected Explore CTEs'; end if;
 source:=substr(source,1,start_at-1)||$ctes$popular as materialized (select id,row_number() over(order by giveaway desc,deal_score desc,deadline,created_at desc,id) as ordinal from ranked where explore_type='all' and popular_rank=1 order by giveaway desc,deal_score desc,deadline,created_at desc,id limit 24),
 popular_buy as materialized (select id,row_number() over(order by giveaway desc,deal_score desc,deadline,created_at desc,id) as ordinal from ranked where explore_type='buy' and popular_rank=1 order by giveaway desc,deal_score desc,deadline,created_at desc,id limit 24),
 popular_direct as materialized (select id,row_number() over(order by giveaway desc,deal_score desc,deadline,created_at desc,id) as ordinal from ranked where explore_type='direct' and popular_rank=1 order by giveaway desc,deal_score desc,deadline,created_at desc,id limit 24),
 popular_escrow as materialized (select id,row_number() over(order by giveaway desc,deal_score desc,deadline,created_at desc,id) as ordinal from ranked where explore_type='escrow' and popular_rank=1 order by giveaway desc,deal_score desc,deadline,created_at desc,id limit 24),
 newest as materialized (select id,row_number() over(order by created_at desc,id) as ordinal from ranked where explore_type='all' and new_rank=1 order by created_at desc,id limit 24),
 new_buy as materialized (select id,row_number() over(order by created_at desc,id) as ordinal from ranked where explore_type='buy' and new_rank=1 order by created_at desc,id limit 24),
 new_direct as materialized (select id,row_number() over(order by created_at desc,id) as ordinal from ranked where explore_type='direct' and new_rank=1 order by created_at desc,id limit 24),
 new_escrow as materialized (select id,row_number() over(order by created_at desc,id) as ordinal from ranked where explore_type='escrow' and new_rank=1 order by created_at desc,id limit 24),
 ending as materialized (select id,row_number() over(order by deadline,created_at desc,id) as ordinal from ranked where explore_type='all' and ending_rank=1 order by deadline,created_at desc,id limit 24),
 ending_buy as materialized (select id,row_number() over(order by deadline,created_at desc,id) as ordinal from ranked where explore_type='buy' and ending_rank=1 order by deadline,created_at desc,id limit 24),
 ending_direct as materialized (select id,row_number() over(order by deadline,created_at desc,id) as ordinal from ranked where explore_type='direct' and ending_rank=1 order by deadline,created_at desc,id limit 24),
 ending_escrow as materialized (select id,row_number() over(order by deadline,created_at desc,id) as ordinal from ranked where explore_type='escrow' and ending_rank=1 order by deadline,created_at desc,id limit 24), $ctes$||substr(source,end_at);
 source:=replace(source,'select id from popular union select id from newest union select id from ending',
 $selected$select id from popular union select id from popular_buy union select id from popular_direct union select id from popular_escrow union select id from newest union select id from new_buy union select id from new_direct union select id from new_escrow union select id from ending union select id from ending_buy union select id from ending_direct union select id from ending_escrow$selected$);
 source:=replace(source,'''highRollers'',coalesce(', $fields$'popular_buy',coalesce((select jsonb_agg(id order by ordinal) from popular_buy),'[]'::jsonb),'popular_direct',coalesce((select jsonb_agg(id order by ordinal) from popular_direct),'[]'::jsonb),'popular_escrow',coalesce((select jsonb_agg(id order by ordinal) from popular_escrow),'[]'::jsonb),'new_buy',coalesce((select jsonb_agg(id order by ordinal) from new_buy),'[]'::jsonb),'new_direct',coalesce((select jsonb_agg(id order by ordinal) from new_direct),'[]'::jsonb),'new_escrow',coalesce((select jsonb_agg(id order by ordinal) from new_escrow),'[]'::jsonb),'ending_buy',coalesce((select jsonb_agg(id order by ordinal) from ending_buy),'[]'::jsonb),'ending_direct',coalesce((select jsonb_agg(id order by ordinal) from ending_direct),'[]'::jsonb),'ending_escrow',coalesce((select jsonb_agg(id order by ordinal) from ending_escrow),'[]'::jsonb),'highRollers',coalesce($fields$);
 execute source;
end $patch$;
-- Four type selections x three tabs x 24, plus High Rollers and Recent.
-- Keep a single shared live read for the bounded Home union.
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.read_public_auction_live_batch(uuid[])'::regprocedure);
 if strpos(source,'cardinality(p_ids)>120')=0 then raise exception 'Unexpected live batch bound'; end if;
 source:=replace(source,'cardinality(p_ids)>120','cardinality(p_ids)>336');
 execute replace(source,'Choose at most 120 public auctions.','Choose at most 336 public auctions.');
end $patch$;
notify pgrst,'reload schema';
commit;
