-- Apply after 061. Server-verified administrators can identify auction parties
-- and every bid; public aliases and participant-only contact data stay unchanged.
begin;
alter function khub_bot.public_auction(public.auctions,bigint,text,text)
    rename to public_auction_before_admin_identities;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_admin_identities(a,p_bid_count,p_highest_label,p_winner_label)
        ||case when khub_bot.is_administrator(auth.uid()) then jsonb_build_object(
            'usernames_visible',true,
            'seller_username',coalesce((select p.khub_username from public.profiles p where p.id=a.seller_id),a.seller_username),
            'highest_bidder_id',a.highest_bidder_id,
            'highest_bidder_username',case when a.highest_bidder_id is not null then
                coalesce((select p.khub_username from public.profiles p where p.id=a.highest_bidder_id),a.highest_bidder_username) end,
            'winner_public',a.winner_id is not null,
            'winner_id',a.winner_id,
            'winner_username',case when a.winner_id is not null then
                coalesce((select p.khub_username from public.profiles p where p.id=a.winner_id),a.winner_username) end
        ) else '{}'::jsonb end;
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text),
    khub_bot.public_auction_before_admin_identities(public.auctions,bigint,text,text) from public,anon,authenticated;

-- Preserve pagination, filters, bid aliases, statistics and existing privacy
-- wrappers. Only an authenticated server-side administrator check reveals IDs.
do $$
declare definition text; patch record;
begin
    definition:=pg_get_functiondef('public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure);
    for patch in select * from (values
        ($text$(a.status<>'pending_escrow' or a.seller_id=auth.uid())$text$,
         $text$(a.status<>'pending_escrow' or a.seller_id=auth.uid() or khub_bot.is_administrator(auth.uid()))$text$),
        ($text$(a.seller_id=p_id and a.status<>'pending_escrow')$text$,
         $text$(a.seller_id=p_id and (a.status<>'pending_escrow' or khub_bot.is_administrator(auth.uid())))$text$),
        ($text$where p_view='seller' and a.seller_id=p_id and a.status<>'pending_escrow'$text$,
         $text$where p_view='seller' and a.seller_id=p_id and (a.status<>'pending_escrow' or khub_bot.is_administrator(auth.uid()))$text$),
        ($text$'bidder_id',case when b.bidder_id=auth.uid() then b.bidder_id end$text$,
         $text$'bidder_id',case when b.bidder_id=auth.uid() or khub_bot.is_administrator(auth.uid()) then b.bidder_id end$text$),
        ($text$'bidder_username',case when b.bidder_id=auth.uid() then 'You' else l.label end$text$,
         $text$'bidder_username',case when khub_bot.is_administrator(auth.uid()) then coalesce((select p.khub_username from public.profiles p where p.id=b.bidder_id),b.bidder_username) when b.bidder_id=auth.uid() then 'You' else l.label end$text$)
    ) as changes(old_text,new_text)
    loop
        if strpos(definition,patch.old_text)=0 then raise exception 'Unexpected auction identity projection; migration not applied.'; end if;
        definition:=replace(definition,patch.old_text,patch.new_text);
    end loop;
    execute definition;
end; $$;
notify pgrst,'reload schema';
commit;
