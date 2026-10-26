-- Apply after 112, then deploy the website. No bot rebuild required.
-- All unrestricted signed-in viewers may see accepted Buy sellers; guests may not.
begin;
do $patch$
declare definition text;
    old_identity text := $identity$'seller',coalesce(nullif(btrim(p.kol_player_name),''),p.khub_username),'seller_id',f.seller_id,$identity$;
    new_identity text := $identity$'seller',case when khub_bot.can_view_usernames()
                then coalesce(nullif(btrim(p.kol_player_name),''),p.khub_username) else 'Seller' end,
            'seller_id',case when khub_bot.can_view_usernames() then f.seller_id end,$identity$;
begin
    definition:=pg_get_functiondef('khub_bot.buy_history(uuid)'::regprocedure);
    if strpos(definition,old_identity)=0 then raise exception 'Apply migration 112 before updating Buy seller visibility.'; end if;
    execute replace(definition,old_identity,new_identity);
end; $patch$;
notify pgrst,'reload schema';
commit;
