-- Reveal bid usernames after actual exchange completion; guests retain aliases.
-- Apply after 087. Preserves admin references and all auction/escrow records.
begin;
do $patch$
declare target regprocedure; definition text; updated text; patched integer:=0;
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        updated:=replace(definition,
            'when b.bidder_id=auth.uid() then ''You'' else l.label end',
            'when khub_bot.can_view_usernames() and exists(select 1 from public.auctions completed_auction
                where completed_auction.id=b.auction_id and (completed_auction.status=''completed''
                    or (completed_auction.finalized_at is not null and completed_auction.winner_id=b.bidder_id)))
                then coalesce((select p.khub_username from public.profiles p where p.id=b.bidder_id),b.bidder_username)
                when b.bidder_id=auth.uid() then ''You'' else l.label end');
        if updated=definition then raise exception 'Unexpected bidder privacy definition: %',target; end if;
        execute updated; patched:=patched+1;
    end loop;
    if patched<>3 then raise exception 'Expected 3 auction reader overloads; found %',patched; end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
