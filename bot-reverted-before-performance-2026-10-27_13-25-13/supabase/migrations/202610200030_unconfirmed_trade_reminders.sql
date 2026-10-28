-- Apply after 029. Hide personal confirmation reminders after that participant confirms.
-- No auction status, confirmation, delivery or counterparty access is changed.
begin;
create or replace function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where auth.uid() is not null and not a.escrow_mode and a.status='awaiting_trade'
        and a.finalized_at is not null and a.winner_id is not null
        and ((a.seller_id=auth.uid() and a.seller_confirmed_at is null)
          or (a.winner_id=auth.uid() and a.buyer_confirmed_at is null))
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
