-- Giveaway leaders must wait for another bidder before bidding again.
-- Apply after 153. Rerunnable; rejected deposits use the existing full refund path.
begin;
do $$
declare
    definition text;
    anchor text := $anchor$elsif a.seller_kol_id=sid then reason:='Sellers cannot bid on their own auction.';$anchor$;
    guard text := $guard$elsif a.giveaway_title is not null and (a.highest_bidder_kol_id=sid or a.highest_bidder_id=u.id) then reason:='You are already the highest bidder on this giveaway. Wait for another bidder before bidding again.';$guard$;
begin
    definition := pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,guard)=0 then
        if strpos(definition,anchor)=0 then
            raise exception 'Unexpected escrow bid writer; inspect before applying giveaway self-outbid guard.';
        end if;
        execute replace(definition,anchor,anchor||E'\n            '||guard);
    end if;
end; $$;
notify pgrst,'reload schema';
commit;
