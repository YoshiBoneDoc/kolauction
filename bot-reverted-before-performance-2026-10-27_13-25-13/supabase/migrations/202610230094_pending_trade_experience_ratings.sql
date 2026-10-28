-- Apply after 093. Keep answered Direct trades in the reminder until rated.
-- Completion responses and experience votes remain independent; no stored data changes.
begin;
create or replace function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where khub_bot.can_view_usernames() and not a.escrow_mode
        and a.status in ('awaiting_trade','completed')
        and a.finalized_at is not null and a.winner_id is not null
        and auth.uid() in (a.seller_id,a.winner_id)
        and (
            (a.status='awaiting_trade'
                and case when a.seller_id=auth.uid() then coalesce(a.seller_confirmed_at,a.seller_resolved_at)
                    else coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) end is null
                and not exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=auth.uid()))
            or (
                (case when a.seller_id=auth.uid() then coalesce(a.seller_confirmed_at,a.seller_resolved_at)
                    else coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) end is not null
                    or exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=auth.uid()))
                and not exists(select 1 from khub_bot.trade_feedback f where f.auction_id=a.id and f.actor_id=auth.uid())
            )
        )
), page as (
    select * from matching order by finalized_at,id limit 12
    offset (greatest(1,least(coalesce(p_page,1),1000000))-1)*12
)
select jsonb_build_object('privacy_version',1,'total',(select count(*) from matching),
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,
        (select count(*) from public.bids b where b.auction_id=a.id),'Anonymous bidder','Anonymous bidder')
        order by a.finalized_at,a.id) from page a),'[]'::jsonb));
$$;
notify pgrst,'reload schema';
commit;
