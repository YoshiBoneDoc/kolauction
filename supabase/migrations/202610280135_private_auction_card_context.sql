-- Private, bounded viewer context for shared public listing snapshots.
-- Apply after 128. The existing public_auction projection remains the authority
-- for names, identities, personal reservations, admin data and financial privacy.
-- No transaction, payment, bot, escrow or auction writes.
begin;
create function public.read_auction_card_context(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if auth.uid() is null then raise exception 'Sign in to read your auction context.' using errcode='42501'; end if;
    if p_ids is null or cardinality(p_ids)>24 then raise exception 'Choose at most 24 auctions.'; end if;
    return (
        with selected as materialized (
            select a.* from public.auctions a where a.id=any(p_ids)
                and a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a)
        ), labels as materialized (
            select b.auction_id,b.bidder_id,
                'Bidder '||row_number() over(partition by b.auction_id order by min(b.created_at),b.bidder_id)::text as label
            from public.bids b where b.auction_id in (select id from selected)
            group by b.auction_id,b.bidder_id
        )
        select jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),
            'rows',coalesce(jsonb_agg(khub_bot.public_auction(a,0,h.label,w.label)-'bid_count'),'[]'::jsonb))
        from selected a
        left join labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
        left join labels w on w.auction_id=a.id and w.bidder_id=a.winner_id
    );
end;$$;
revoke all on function public.read_auction_card_context(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.read_auction_card_context(uuid[]) to authenticated;
notify pgrst,'reload schema';
commit;
