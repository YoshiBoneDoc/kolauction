-- Share the exact giveaway calculation between public display and admin analytics.
begin;
create or replace function khub_bot.giveaway_meat_total() returns numeric
language sql stable security definer set search_path='' as $$
    select coalesce(sum(a.quantity::numeric * 1000),0)
    from public.auctions a
    where a.status='completed' and a.auction_kind='sell' and a.winner_id is not null
        and (a.seller_kol_id=3552305 or exists (
            select 1 from public.profiles p where p.id=a.seller_id and p.kol_player_id=3552305))
        and a.item_id=258 and a.bundle_items='[]'::jsonb;
$$;
revoke all on function khub_bot.giveaway_meat_total() from public,anon,authenticated;
create or replace function public.read_giveaway_total() returns text
language sql stable security definer set search_path='' as $$
    select khub_bot.giveaway_meat_total()::text;
$$;
revoke all on function public.read_giveaway_total() from public;
grant execute on function public.read_giveaway_total() to anon,authenticated;

do $$
declare definition text; start_at integer; end_at integer;
begin
    definition:=pg_get_functiondef('public.read_admin_analytics()'::regprocedure);
    start_at:=strpos(definition,'''giveaways'',jsonb_build_object');
    end_at:=strpos(definition,'''users'',');
    if start_at=0 or end_at<=start_at then raise exception 'Unexpected admin analytics definition.';end if;
    execute substr(definition,1,start_at-1)
        ||'''giveaways'',jsonb_build_object(''meat_stack_mania'',khub_bot.giveaway_meat_total()::text),'
        ||substr(definition,end_at);
end;$$;
notify pgrst,'reload schema';
commit;
