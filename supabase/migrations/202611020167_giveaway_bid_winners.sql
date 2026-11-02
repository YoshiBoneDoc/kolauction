-- Mark actual prize recipients without exposing bidder identities.
begin;
create function khub_bot.giveaway_winning_bid(p_bid_id uuid) returns boolean
language sql stable set search_path='' as $$
    select exists(
        select 1 from public.bids b join public.auctions a on a.id=b.auction_id
        where b.id=p_bid_id and a.giveaway_title is not null
          and a.status in ('settling','awaiting_trade','completed')
          and case when a.giveaway_win_condition='split' then exists(
              select 1 from khub_bot.giveaway_awards w
              where w.auction_id=a.id and w.user_id=b.bidder_id and w.quantity>0
          ) else a.winner_id=b.bidder_id end
          and b.id=(select latest.id from public.bids latest
              where latest.auction_id=b.auction_id and latest.bidder_id=b.bidder_id
              order by latest.created_at desc,latest.amount desc,latest.id desc limit 1)
    );
$$;
revoke all on function khub_bot.giveaway_winning_bid(uuid) from public,anon,authenticated,service_role;

do $patch$
declare target regprocedure; definition text; patched integer:=0;
    anchor text := '''id'',b.id,''auction_id'',b.auction_id,''amount'',b.amount,''created_at'',b.created_at,';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,anchor)=0 then raise exception 'Unexpected bid projection: %',target; end if;
        execute replace(definition,anchor,anchor||E'\n        ''giveaway_winner'',khub_bot.giveaway_winning_bid(b.id),');
        patched:=patched+1;
    end loop;
    if patched=0 then raise exception 'No auction readers found'; end if;
end;
$patch$;
notify pgrst,'reload schema';
commit;
