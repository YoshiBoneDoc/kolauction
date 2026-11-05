-- After 230. Apply before the matching website/bot. No financial rules change.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
-- Keep the complete diagnostic/legacy endpoint. Routine payloads include only
-- observed IDs plus every unresolved envelope, attempt, review and unposted gift.
create function public.bot_gift_intake_state_scoped(p_ids text[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if p_ids is null or cardinality(p_ids)>10000 or exists(select 1 from unnest(p_ids) id where id is null or id !~ '^[1-9][0-9]*$') then raise exception 'Invalid complete inbox IDs'; end if;
 return jsonb_build_object('scoped_version',1,'isolation_version',1,
 'attempt',(select to_jsonb(a) from khub_bot.gift_open_attempts a where state='opening'),
 'isolated',coalesce((select jsonb_agg(to_jsonb(a)) from khub_bot.gift_open_attempts a where state='isolated'),'[]'::jsonb),
 'reviews',coalesce((select jsonb_agg(mail_id) from khub_bot.gift_mail_reviews where resolved_at is null),'[]'::jsonb),
 'review_mail',coalesce((select jsonb_agg(to_jsonb(r)) from khub_bot.gift_mail_reviews r where resolved_at is null),'[]'::jsonb),
 'resolved_review_mail',coalesce((select jsonb_agg(jsonb_build_object('mail_id',mail_id,'raw',raw)) from khub_bot.gift_mail_reviews where resolved_at is not null and mail_id=any(p_ids)),'[]'::jsonb),
 'legacy_ids',coalesce((select jsonb_agg(mail_id) from khub_bot.receipts where mail_id=any(p_ids) and payload#>>'{raw,type}'='giftshop' and result='donation'),'[]'::jsonb),
 'mails',coalesce((select jsonb_agg(jsonb_build_object('id',g.mail_id,'wrapper_id',g.wrapper_id,'raw',g.envelope,
 'payload',g.payload,'legacy_donation',g.legacy_donation,'posted',exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)) order by g.mail_id::bigint)
 from khub_bot.incoming_gifts g where g.mail_id=any(p_ids)
 or (not g.legacy_donation and (g.payload is null or not exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)))
 or exists(select 1 from khub_bot.gift_open_attempts a where a.state in ('opening','isolated') and (a.mail_id=g.mail_id or a.before_state->>'requested_mail_id'=g.mail_id))
 or exists(select 1 from khub_bot.gift_mail_reviews r where r.mail_id=g.mail_id and r.resolved_at is null)), '[]'::jsonb));
end $$;
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.bot_register_gift_mail(jsonb)'::regprocedure);
 if strpos(source,'return public.bot_gift_intake_state();')=0 then raise exception 'Unexpected gift registration response'; end if;
 source:=replace(source,'FUNCTION public.bot_register_gift_mail(p_envelopes jsonb)', 'FUNCTION public.bot_register_gift_mail_scoped(p_envelopes jsonb, p_ids text[])');
 source:=replace(source,'return public.bot_gift_intake_state();','return public.bot_gift_intake_state_scoped(p_ids);');
 execute source;
 foreach source in array array[pg_get_functiondef('public.bot_worker_status()'::regprocedure),pg_get_functiondef('public.bot_worker_safety()'::regprocedure)] loop
  if strpos(source,'''capabilityRevision'',230')=0 then raise exception 'Unexpected worker capability revision'; end if;
  execute replace(source,'''capabilityRevision'',230','''capabilityRevision'',231,''scopedGiftStateVersion'',1');
 end loop;
end $patch$;
revoke all on function public.bot_gift_intake_state_scoped(text[]),public.bot_register_gift_mail_scoped(jsonb,text[]) from public,anon,authenticated,service_role;
grant execute on function public.bot_gift_intake_state_scoped(text[]),public.bot_register_gift_mail_scoped(jsonb,text[]) to service_role;

-- No full detail/financial/history projection for any shared listing card.
-- Seller checks remain once per distinct seller, extending migration 192 to Buy.
create or replace function public.read_auction_card_context(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare viewer uuid:=auth.uid(); admin boolean:=khub_bot.is_administrator(viewer); names boolean:=khub_bot.can_view_usernames();
begin
 if viewer is null then raise exception 'Sign in to read your auction context.' using errcode='42501'; end if;
 if p_ids is null or cardinality(p_ids)>24 or array_position(p_ids,null) is not null then raise exception 'Choose at most 24 auctions.'; end if;
 return (with requested as materialized (
  select a.* from khub_bot.visible_auctions() a where a.id=any(p_ids) and a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a)
 ), sellers as materialized (
  select seller_id,khub_bot.profile_is_restricted(seller_id) restricted from (select distinct seller_id from requested where status='active') x
 ), context as (
  select a.*, not a.escrow_mode and a.finalized_at is not null and a.winner_id is not null and a.status in ('awaiting_trade','completed') closed_direct,
   names and a.finalized_at is not null and a.winner_id is not null and a.status in ('awaiting_trade','settling','completed') public_winner
  from requested a
 ) select jsonb_build_object('privacy_version',1,'card_context_version',2,'server_time',statement_timestamp(),
 'rows',coalesce(jsonb_agg(jsonb_build_object(
  'id',a.id,'status',a.status,'seller_id',a.seller_id,'current_bid',a.current_bid,'usernames_visible',names or admin,
  'seller_username',case when names or admin then coalesce(s.khub_username,a.seller_username) else 'Seller' end,
  'highest_bidder_id',case when admin or a.highest_bidder_id=viewer or (a.closed_direct and names and viewer in (a.seller_id,a.winner_id)) then a.highest_bidder_id end,
  'highest_bidder_username',case when a.highest_bidder_id is null then null when admin then coalesce(b.khub_username,a.highest_bidder_username)
   when a.closed_direct and names and viewer in (a.seller_id,a.winner_id) then a.highest_bidder_username
   when a.highest_bidder_id=viewer then 'You' else coalesce('Bidder '||h.ordinal::text,'Anonymous bidder') end,
  'viewer_is_highest_bidder',case when a.highest_bidder_id is null then null else a.highest_bidder_id=viewer end,
  'winner_public',case when admin then a.winner_id is not null else a.public_winner end,
  'winner_id',case when admin or a.public_winner or a.winner_id=viewer or (a.closed_direct and names and viewer in (a.seller_id,a.winner_id)) then a.winner_id end,
  'winner_username',case when a.winner_id is null then null when admin then coalesce(winner.khub_username,a.winner_username) when not names then 'Winner'
   when a.public_winner then coalesce(winner.khub_username,a.winner_username) when a.closed_direct and viewer in (a.seller_id,a.winner_id) then a.winner_username
   when a.winner_id=viewer then 'You' else coalesce('Bidder '||w.ordinal::text,'Anonymous bidder') end,
  'bidding_restricted',case when a.status='active' then (select restricted from sellers where seller_id=a.seller_id) else false end,
  'escrow_timing_review',a.escrow_timing_review,
  'trade_reported',case when a.closed_direct then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.withdrawn_at is null and t.counts_negative) end
 ) || case when a.auction_kind='buy' then jsonb_build_object('my_reservation',
  (select jsonb_build_object('id',r.id,'quantity',r.quantity,'expires_at',r.expires_at,'created_at',r.created_at)
   from khub_bot.buy_reservations r where r.auction_id=a.id and r.seller_id=viewer and r.state='active')) else '{}'::jsonb end),'[]'::jsonb))
 from context a left join public.profiles s on s.id=a.seller_id left join public.profiles b on b.id=a.highest_bidder_id
 left join public.profiles winner on winner.id=a.winner_id
 left join khub_bot.auction_bidder_labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
 left join khub_bot.auction_bidder_labels w on w.auction_id=a.id and w.bidder_id=a.winner_id);
end $$;

-- Public Home/browse Buy cards need quantities, not fulfillment history, private
-- balances, contact/report queries or reservation-audit construction.
do $patch$
declare source text; old text;
begin
 source:=pg_get_functiondef('khub_bot.public_listing_projection(public.auctions,bigint,text,text)'::regprocedure);
 old:='return khub_bot.public_auction(a,p_bid_count,p_highest_label,p_winner_label);';
 if strpos(source,old)=0 then raise exception 'Unexpected public Buy projection'; end if;
 -- Reuse the installed Sell projection's exact public field whitelist below by
 -- removing the early Buy branch and appending only the required Buy state.
 source:=replace(source,'    if a.auction_kind=''buy'' then'||chr(10)||'        '||old||chr(10)||'    end if;', '');
 if strpos(source,old)>0 then raise exception 'Unexpected Buy branch layout'; end if;
 if strpos(source,'''bidding_restricted'',a.status=''active'' and khub_bot.profile_is_restricted(a.seller_id));')=0 then raise exception 'Unexpected public projection field layout'; end if;
 source:=replace(source,'''bidding_restricted'',a.status=''active'' and khub_bot.profile_is_restricted(a.seller_id));',
 '''bidding_restricted'',a.status=''active'' and khub_bot.profile_is_restricted(a.seller_id)) || case when a.auction_kind=''buy'' then coalesce((select jsonb_build_object(
 ''price_per_item'',a.min_bid_meat,''purchased_quantity'',o.purchased_quantity,''remaining_quantity'',greatest(0,a.quantity-o.purchased_quantity-o.reduced_quantity),
 ''available_quantity'',khub_bot.buy_available(a.id),''reserved_quantity'',coalesce((select sum(quantity) from khub_bot.buy_reservations where auction_id=a.id and state=''active''),0),
 ''reduced_quantity'',o.reduced_quantity,''delivery_mode'',o.delivery_mode,''buy_closing_reason'',o.close_reason)
 from khub_bot.buy_orders o where o.auction_id=a.id),''{}''::jsonb) else ''{}''::jsonb end;');
 execute source;
end $patch$;
-- Home displays public card facts for every viewer. Keep legacy detail-rich
-- endpoints intact; the new route retains the installed visibility and sections.
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.read_home_auctions_before_site_totals()'::regprocedure);
 if strpos(source,'khub_bot.public_home_listing_projection(a,')=0 then raise exception 'Unexpected Home card projection'; end if;
 source:=replace(source,'FUNCTION public.read_home_auctions_before_site_totals()', 'FUNCTION khub_bot.home_cards_core()');
 source:=replace(source,'khub_bot.public_home_listing_projection(a,','khub_bot.public_listing_projection(a,');
 execute source;
end $patch$;
create function public.read_home_cards() returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.home_cards_core() || jsonb_build_object('site_totals',khub_bot.site_trade_totals());
$$;
revoke all on function khub_bot.home_cards_core(),public.read_home_cards() from public,anon,authenticated,service_role;
grant execute on function public.read_home_cards() to anon,authenticated;
notify pgrst,'reload schema';
commit;
