-- Apply once after 296. Integrate barter reputation and confirmation notices.
begin;
create index barter_response_actor on khub_bot.barter_trade_responses(actor_id,auction_id);
grant all on khub_bot.barter_trade_responses to service_role;

alter function khub_bot.profile_feedback(uuid) rename to profile_feedback_before_barters;
revoke all on function khub_bot.profile_feedback_before_barters(uuid) from public,anon,authenticated;
create function khub_bot.profile_feedback(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 with votes as (
 select r.*,a.seller_id,o.bidder_id from khub_bot.barter_trade_responses r
 join khub_bot.barter_auctions a on a.id=r.auction_id
 join khub_bot.barter_offers o on o.id=a.current_offer_id and o.auction_id=a.id
 where a.cancelled_at is null and a.end_time<=statement_timestamp()
 ), totals as (
 select count(*) filter(where bidder_id=actor_id and seller_id=p_user and rating=1) sp,
 count(*) filter(where bidder_id=actor_id and seller_id=p_user and rating=-1) sn,
 count(*) filter(where seller_id=actor_id and bidder_id=p_user and rating=1) bp,
 count(*) filter(where seller_id=actor_id and bidder_id=p_user and rating=-1) bn,
 count(*) filter(where bidder_id=actor_id and seller_id=p_user) sc,
 count(*) filter(where seller_id=actor_id and bidder_id=p_user) bc from votes
 ), base as (select khub_bot.profile_feedback_before_barters(p_user) j)
 select j||jsonb_build_object('seller_positive',(j->>'seller_positive')::bigint+sp,
 'seller_negative',(j->>'seller_negative')::bigint+sn,'buyer_positive',(j->>'buyer_positive')::bigint+bp,
 'buyer_negative',(j->>'buyer_negative')::bigint+bn,'seller_confirmed',(j->>'seller_confirmed')::bigint+sc,
 'buyer_confirmed',(j->>'buyer_confirmed')::bigint+bc) from base,totals;
$$;
revoke all on function khub_bot.profile_feedback(uuid) from public,anon,authenticated;

create function khub_bot.barter_confirmation_notice() returns trigger
language plpgsql security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; bidder uuid; recipient public.profiles%rowtype; actor_name text; body text;
begin
 select * into a from khub_bot.barter_auctions where id=new.auction_id;
 select bidder_id into bidder from khub_bot.barter_offers where id=a.current_offer_id;
 select * into recipient from public.profiles where id=case when new.actor_id=a.seller_id then bidder else a.seller_id end;
 select khub_username into actor_name from public.profiles where id=new.actor_id;
 if recipient.kol_player_id is null or recipient.kol_verified_at is null then return new; end if;
 body:='Barter '||a.id||E'\n'||a.quantity||' x '||khub_bot.escape_report_kmail(left(a.item,80))||E'\n\n'||khub_bot.escape_report_kmail(actor_name)||' confirmed receipt of the agreed exchange. Both players must confirm completion. This confirmation does not change your feedback score. View the barter on kHub for details.';
 insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
 values('barter-confirmation:'||a.id||':'||new.actor_id,recipient.kol_player_id,'notice',body,body,'');
 return new;
end; $$;
revoke all on function khub_bot.barter_confirmation_notice() from public,anon,authenticated;
create trigger barter_confirmation_notice after insert on khub_bot.barter_trade_responses for each row execute function khub_bot.barter_confirmation_notice();
notify pgrst,'reload schema';
commit;
