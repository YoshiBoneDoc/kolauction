begin;
alter table public.auctions add column giveaway_win_condition text not null default 'last_bid'
 check (giveaway_win_condition in ('last_bid','random_draw','split','surprise'));

create function khub_bot.resolve_giveaway_condition() returns trigger language plpgsql set search_path='' as $$
begin
 if old.giveaway_title is not null and old.giveaway_win_condition<>'surprise' and new.giveaway_win_condition<>old.giveaway_win_condition then
   raise exception 'The giveaway win condition is fixed.';
 end if;
 if new.status='active' and new.giveaway_win_condition='surprise' then
   new.giveaway_win_condition:=(array['last_bid','random_draw','split'])[1+floor(random()*3)::integer];
 end if;
 return new;
end;$$;
create trigger resolve_giveaway_condition before update on public.auctions for each row execute function khub_bot.resolve_giveaway_condition();
revoke all on function khub_bot.resolve_giveaway_condition() from public,anon,authenticated,service_role;

-- Default arguments preserve older callers.
create function public.create_giveaway_auction(p_item text,p_quantity bigint,p_min_bid_meat bigint,p_duration_hours integer,p_image text,p_instant_purchase_price bigint,p_item_id integer,p_escrow_mode boolean,p_title text,p_custom_end_at timestamptz default null,p_win_condition text default 'last_bid')
returns uuid language plpgsql security definer set search_path='' as $$
declare aid uuid;
begin
 if p_win_condition is null or p_win_condition not in ('last_bid','random_draw','split','surprise') then raise exception 'Invalid win condition.';end if;
 if p_win_condition<>'last_bid' and not p_escrow_mode then raise exception 'This win condition requires Escrow delivery.';end if;
 aid:=public.create_giveaway_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode,p_title,p_custom_end_at);
 -- Creation metadata is assigned together before publication returns.
 update public.auctions set giveaway_title=btrim(p_title),giveaway_win_condition=p_win_condition where id=aid;
 return aid;
end;$$;
-- Remove ambiguity for calls omitting default arguments: the new RPC replaces the old signature.
-- Its implementation below incorporates the original creation body instead of calling an overload.
do $$declare d text; old text;begin
 d:=pg_get_functiondef('public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz,text)'::regprocedure);
 old:='aid:=public.create_giveaway_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode,p_title,p_custom_end_at);';
 d:=replace(d,old,$body$
 if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
 if p_title is null or length(btrim(p_title)) not between 1 and 80 then raise exception 'A giveaway needs a title.';end if;
 if p_custom_end_at is null then
 aid:=public.create_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode);
 else
 aid:=public.create_auction(p_item,p_quantity,p_min_bid_meat,p_duration_hours,p_image,p_instant_purchase_price,p_item_id,p_escrow_mode,p_custom_end_at);
 end if;
 $body$);
 execute d;
end;$$;
drop function public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz);
revoke all on function public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz,text) from public,anon;
grant execute on function public.create_giveaway_auction(text,bigint,bigint,integer,text,bigint,integer,boolean,text,timestamptz,text) to authenticated;

-- Snapshot identities and whole-item allocations in the same transaction as settlement.
create table khub_bot.giveaway_awards(
 auction_id uuid references public.auctions(id),player_id bigint,user_id uuid references public.profiles(id),quantity bigint not null,
 primary key(auction_id,player_id));
revoke all on khub_bot.giveaway_awards from public,anon,authenticated,service_role;
create function khub_bot.plan_giveaway(a public.auctions) returns public.auctions language plpgsql set search_path='' as $$
declare n bigint; chosen record;
begin
 if a.giveaway_title is null or a.giveaway_win_condition='last_bid' or a.highest_bidder_id is null then return a;end if;
 if not exists(select 1 from khub_bot.giveaway_awards where auction_id=a.id) then
   if a.giveaway_win_condition='random_draw' then
     insert into khub_bot.giveaway_awards
     select a.id,kol_player_id,id,a.quantity from (
       select distinct on (p.kol_player_id) p.kol_player_id,p.id from public.bids b join public.profiles p on p.id=b.bidder_id
       where b.auction_id=a.id and p.kol_player_id is not null order by p.kol_player_id,p.id
     ) participants order by random() limit 1;
   else
     select count(distinct p.kol_player_id) into n from public.bids b join public.profiles p on p.id=b.bidder_id where b.auction_id=a.id;
     insert into khub_bot.giveaway_awards
     select a.id,kol_player_id,id,a.quantity/n+case when row_number() over(order by random())<=a.quantity%n then 1 else 0 end
     from (select distinct on(p.kol_player_id) p.kol_player_id,p.id from public.bids b join public.profiles p on p.id=b.bidder_id
       where b.auction_id=a.id and p.kol_player_id is not null order by p.kol_player_id,p.id) participants;
   end if;
 end if;
 if a.giveaway_win_condition='random_draw' then
   select w.*,p.khub_username into chosen from khub_bot.giveaway_awards w join public.profiles p on p.id=w.user_id where w.auction_id=a.id;
   if not found then raise exception 'Giveaway has no eligible participants';end if;
   a.highest_bidder_id:=chosen.user_id;a.highest_bidder_kol_id:=chosen.player_id;a.highest_bidder_username:=chosen.khub_username;
 end if;
 return a;
end;$$;
create function khub_bot.queue_giveaway_prize(a public.auctions) returns void language plpgsql set search_path='' as $$
declare w record;
begin
 if a.giveaway_title is not null and a.giveaway_win_condition='split' then
   for w in select * from khub_bot.giveaway_awards where auction_id=a.id and quantity>0 loop
     perform khub_bot.queue('giveaway:'||a.id||':'||w.player_id,a.id,null,w.player_id,'sale_item',0,
       jsonb_build_array(jsonb_build_object('id',a.item_id,'quantity',w.quantity)),'Giveaway: your share of the prize.');
   end loop;
 else
   perform khub_bot.queue('sale-item:'||a.id,a.id,null,a.highest_bidder_kol_id,'sale_item',0,khub_bot.auction_items(a),'Auction '||a.id||': your winning item(s).');
 end if;
end;$$;
revoke all on function khub_bot.plan_giveaway(public.auctions),khub_bot.queue_giveaway_prize(public.auctions) from public,anon,authenticated,service_role;
-- Integrate inside the existing inbox authorization boundary; leave bid funding and seller payment intact.
do $$declare d text; marker text;begin
 d:=pg_get_functiondef('khub_bot.finish_listing_before_receipt_time(uuid,text)'::regprocedure);
 marker:='outcome:=case';
 if strpos(d,marker)=0 then raise exception 'Unexpected settlement source';end if;
 d:=replace(d,marker,'a:=khub_bot.plan_giveaway(a); '||marker);
 d:=replace(d,'then highest_bidder_id end','then case when a.giveaway_win_condition=''split'' then null else a.highest_bidder_id end end');
 d:=replace(d,'then highest_bidder_username end','then case when a.giveaway_win_condition=''split'' then null else a.highest_bidder_username end end');
 marker:='perform khub_bot.queue(''sale-item:''||p_id,p_id,null,a.highest_bidder_kol_id,''sale_item'',0,';
 if strpos(d,marker)=0 then raise exception 'Unexpected prize queue source';end if;
 d:=replace(d,marker||E'\n            khub_bot.auction_items(a),''Auction ''||p_id||'': your winning item(s).'');','perform khub_bot.queue_giveaway_prize(a);');
 if strpos(d,marker)>0 then raise exception 'Prize queue integration failed';end if;
 execute d;
end;$$;
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_win_conditions;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text) returns jsonb
language sql stable security definer set search_path='' as $$
 select khub_bot.public_auction_before_win_conditions(a,p_bid_count,p_highest_label,p_winner_label)||jsonb_build_object('giveaway_win_condition',a.giveaway_win_condition);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text),khub_bot.public_auction_before_win_conditions(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
do $$declare d text;begin
 d:=pg_get_functiondef('public.read_public_auction_detail_state(uuid)'::regprocedure);
 execute replace(d,'''bundle_items''','''bundle_items'',''giveaway_title'',''giveaway_win_condition''');
end;$$;
do $$declare c record;begin
 for c in select conname,pg_get_constraintdef(oid) d from pg_constraint where conrelid='public.auctions'::regclass and conname='auction_instant_purchase_outcome' loop
 execute 'alter table public.auctions drop constraint '||quote_ident(c.conname);
 execute 'alter table public.auctions add constraint '||quote_ident(c.conname)||' '||replace(c.d,'winner_id IS NOT NULL','(winner_id IS NOT NULL OR giveaway_win_condition = ''split'')');
 end loop;
end;$$;
alter table public.auctions drop constraint auction_winner_price_pair;
alter table public.auctions add constraint auction_winner_price_pair check (
 (winner_id is null and final_price is null) or (winner_id is not null and final_price is not null)
 or (giveaway_title is not null and giveaway_win_condition='split' and final_price is not null));
notify pgrst,'reload schema';
commit;
