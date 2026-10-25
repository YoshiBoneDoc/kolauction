-- Apply after 111, then deploy the website. Read-only Buy history change.
-- Accepted fulfillment sellers are public, including historical fulfillments.
begin;
do $patch$
declare definition text;
    old_identity text := $identity$'seller',case when khub_bot.can_view_usernames() and (khub_bot.is_administrator(auth.uid()) or auth.uid() in (a.seller_id,f.seller_id))
                then p.khub_username else 'Seller' end,$identity$;
begin
    definition:=pg_get_functiondef('khub_bot.buy_history(uuid)'::regprocedure);
    if strpos(definition,old_identity)=0 then raise exception 'Unexpected Buy fulfillment history definition.'; end if;
    execute replace(definition,old_identity,
        $identity$'seller',coalesce(nullif(btrim(p.kol_player_name),''),p.khub_username),'seller_id',f.seller_id,$identity$);
end; $patch$;
-- Keep the existing private helper permissions, fee filters, admin-only receipt
-- and delivery references, ordering and pagination. No ledger rows are modified.
notify pgrst,'reload schema';
commit;
