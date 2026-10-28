-- Apply after 039. Each participant can leave one final rating per trade.
begin;
create or replace function public.rate_trade_partner(p_auction_id uuid,p_rating integer) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; actor uuid:=auth.uid(); responded boolean;
begin
    if not khub_bot.can_view_usernames() then raise exception 'Log in with an unrestricted account to rate a trade.' using errcode='42501'; end if;
    if p_rating is null or p_rating not in (-1,1) then raise exception 'Choose thumbs up or thumbs down.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or actor not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winning buyer of a closed direct sale can rate their trading partner.';
    end if;
    responded:=case when actor=a.seller_id then coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null
        else coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null end
        or exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=actor);
    if not responded then raise exception 'Mark the trade complete or incomplete before rating your trading partner.'; end if;
    insert into khub_bot.trade_feedback(auction_id,actor_id,recipient_id,recipient_role,rating)
        values(a.id,actor,case when actor=a.seller_id then a.winner_id else a.seller_id end,
            case when actor=a.seller_id then 'buyer' else 'seller' end,p_rating)
        on conflict (auction_id,actor_id) do nothing;
    -- Identical retries are safe; a second, different vote is rejected.
    if exists(select 1 from khub_bot.trade_feedback f where f.auction_id=a.id
        and f.actor_id=actor and f.rating<>p_rating) then
        raise exception 'Your rating has already been submitted and cannot be changed.';
    end if;
end; $$;
revoke all on function public.rate_trade_partner(uuid,integer) from public,anon,authenticated;
grant execute on function public.rate_trade_partner(uuid,integer) to authenticated;

notify pgrst,'reload schema';
commit;
