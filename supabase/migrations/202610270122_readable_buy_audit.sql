-- Apply after 121. Read-only admin projection: resolve reservation sellers in
-- the existing capped audit result. No new RPC, permissions or financial writes.
begin;
do $patch$
declare target regprocedure; definition text;
    anchor text:='jsonb_agg(to_jsonb(e) order by e.id desc)';
begin
    select p.oid::regprocedure into strict target
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname in ('public','khub_bot') and p.prokind='f'
        and strpos(p.prosrc,anchor)>0;
    definition:=pg_get_functiondef(target);
    if strpos(definition,'khub_bot.is_administrator(auth.uid())')=0
        or strpos(definition,'from khub_bot.buy_order_events where auction_id=a.id order by id desc limit 100')=0 then
        raise exception 'Unexpected admin-only Buy audit projection; review before applying.';
    end if;
    definition:=replace(definition,anchor,$code$jsonb_agg(to_jsonb(e)||jsonb_build_object('actor_name',(
        select coalesce(nullif(p.kol_player_name,''),nullif(p.khub_username,''),'User')
        from khub_bot.buy_reservations r join public.profiles p on p.id=r.seller_id
        where r.id=e.reservation_id and r.auction_id=a.id
    )) order by e.id desc)$code$);
    execute definition;
end; $patch$;
notify pgrst,'reload schema';
commit;
