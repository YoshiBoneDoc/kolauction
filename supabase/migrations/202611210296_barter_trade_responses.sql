-- Apply after 295. Separate barter responses never represent Meat payments.
begin;
create table khub_bot.barter_trade_responses (
 auction_id uuid not null references khub_bot.barter_auctions(id),
 actor_id uuid not null references public.profiles(id),
 confirmed_at timestamptz not null default clock_timestamp(),
 rating smallint check(rating in (-1,1)),
 primary key(auction_id,actor_id)
);
alter table khub_bot.barter_trade_responses enable row level security;
revoke all on khub_bot.barter_trade_responses from public,anon,authenticated;
create function public.confirm_barter_trade(p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; bidder uuid;
begin
 if auth.uid() is null or not khub_bot.can_view_usernames() then raise exception 'Sign in with an eligible account.'; end if;
 select * into a from khub_bot.barter_auctions where id=p_id for update;
 if not found then raise exception 'Barter unavailable.'; end if;
 select bidder_id into bidder from khub_bot.barter_offers where id=a.current_offer_id and auction_id=a.id and status='accepted';
 if a.cancelled_at is not null or a.end_time>clock_timestamp() or bidder is null or auth.uid() not in (a.seller_id,bidder) then raise exception 'Only participants in a concluded barter can confirm.'; end if;
 insert into khub_bot.barter_trade_responses(auction_id,actor_id) values(a.id,auth.uid()) on conflict do nothing;
end; $$;
create function public.rate_barter_partner(p_id uuid,p_rating integer) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_rating is null or p_rating not in (-1,1) then raise exception 'Choose thumbs up or thumbs down.'; end if;
 if auth.uid() is null or not khub_bot.can_view_usernames() then raise exception 'Sign in with an eligible account.'; end if;
 update khub_bot.barter_trade_responses set rating=p_rating where auction_id=p_id and actor_id=auth.uid() and rating is null;
 if not found and not exists(select 1 from khub_bot.barter_trade_responses where auction_id=p_id and actor_id=auth.uid() and rating=p_rating) then raise exception 'Confirm completion before rating; saved ratings cannot be changed.'; end if;
end; $$;
create function public.read_barter_trades() returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(row order by ending,id),'[]'::jsonb) from (
 select a.id,a.end_time ending,jsonb_build_object('id',a.id,'item',a.item,'quantity',a.quantity,
 'isHost',a.seller_id=auth.uid(),'confirmed',r.confirmed_at is not null,'rating',r.rating,
 'completed',(select count(*)=2 from khub_bot.barter_trade_responses x where x.auction_id=a.id)) row
 from khub_bot.barter_auctions a join khub_bot.barter_offers o on o.id=a.current_offer_id and o.auction_id=a.id and o.status='accepted'
 left join khub_bot.barter_trade_responses r on r.auction_id=a.id and r.actor_id=auth.uid()
 where khub_bot.can_view_usernames() and auth.uid() in (a.seller_id,o.bidder_id) and a.cancelled_at is null and a.end_time<=statement_timestamp() and r.rating is null
 order by a.end_time,a.id limit 12
 ) t;
$$;
revoke all on function public.confirm_barter_trade(uuid),public.rate_barter_partner(uuid,integer),public.read_barter_trades() from public,anon,authenticated;
grant execute on function public.confirm_barter_trade(uuid),public.rate_barter_partner(uuid,integer),public.read_barter_trades() to authenticated;
notify pgrst,'reload schema';
commit;
