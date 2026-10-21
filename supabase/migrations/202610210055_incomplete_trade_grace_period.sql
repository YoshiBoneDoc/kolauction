-- Apply after 054. Delay profile incomplete counts AND values until 48 hours
-- after auction close. Buyouts close at finalized_at; ordinary expiry closes at
-- end_time, even if finalization ran late. Reports remain available immediately
-- for participants/admins. No report rows, feedback votes or outcomes change.
-- Eligibility is computed on read, so crossing 48 hours needs no scheduled job.
begin;
create or replace function khub_bot.profile_feedback(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object(
    'direct_bought_value',(select coalesce(sum(a.final_price),0)::text from public.auctions a
        where a.winner_id=p_user and not a.escrow_mode and a.status='completed' and a.finalized_at is not null),
    'escrow_buys',(select count(*) from public.auctions a
        where a.winner_id=p_user and a.escrow_mode and a.status='completed' and a.finalized_at is not null),
    'escrow_bought_value',(select coalesce(sum(a.final_price),0)::text from public.auctions a
        where a.winner_id=p_user and a.escrow_mode and a.status='completed' and a.finalized_at is not null),
    'seller_positive',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='seller' and rating=1),
    'seller_negative',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='seller' and rating=-1),
    'buyer_positive',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='buyer' and rating=1),
    'buyer_negative',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='buyer' and rating=-1),
    'seller_confirmed',(select count(*) from public.auctions a where not a.escrow_mode and a.seller_id=p_user
        and a.finalized_at is not null and a.winner_id is not null and coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null and a.status='completed'),
    'buyer_confirmed',(select count(*) from public.auctions a where not a.escrow_mode and a.winner_id=p_user
        and a.finalized_at is not null and coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null and a.status='completed'),
    'seller_incomplete_value',(select coalesce(sum(a.final_price),0)::text from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode
        and a.finalized_at is not null and least(a.end_time,a.finalized_at)<=now()-interval '48 hours' and t.reporter_role='buyer' and a.seller_id=p_user),
    'buyer_incomplete_value',(select coalesce(sum(a.final_price),0)::text from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode
        and a.finalized_at is not null and least(a.end_time,a.finalized_at)<=now()-interval '48 hours' and t.reporter_role='seller' and a.winner_id=p_user),
    'seller_incomplete',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode
        and a.finalized_at is not null and least(a.end_time,a.finalized_at)<=now()-interval '48 hours' and t.reporter_role='buyer' and a.seller_id=p_user),
    'buyer_incomplete',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode
        and a.finalized_at is not null and least(a.end_time,a.finalized_at)<=now()-interval '48 hours' and t.reporter_role='seller' and a.winner_id=p_user)
);
$$;

notify pgrst,'reload schema';
commit;
