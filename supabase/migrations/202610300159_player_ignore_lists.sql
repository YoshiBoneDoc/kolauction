-- Apply after 158. Private ignore lists; Direct visibility and write guards.
begin;
create table public.player_ignores (
    user_id uuid not null references public.profiles(id) on delete cascade,
    kol_player_id bigint not null check(kol_player_id between 1 and 9007199254740991),
    primary key(user_id,kol_player_id)
);
create index player_ignores_player_idx on public.player_ignores(kol_player_id,user_id);
alter table public.player_ignores enable row level security;
revoke all on public.player_ignores from public,anon,authenticated;

create function public.read_player_ignores() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Please sign in.'; end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',i.kol_player_id::text,'name',p.kol_player_name) order by i.kol_player_id)
 from public.player_ignores i left join public.profiles p on p.kol_player_id=i.kol_player_id
 where i.user_id=auth.uid()),'[]'::jsonb);
end;$$;
create function public.set_player_ignored(p_player_id bigint,p_ignored boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 if auth.uid() is null then raise exception 'Please sign in.'; end if;
 if p_player_id is null or p_player_id not between 1 and 9007199254740991 or p_ignored is null then raise exception 'Enter a positive whole KoL player ID.'; end if;
 if exists(select 1 from public.profiles where id=auth.uid() and kol_player_id=p_player_id) then raise exception 'You cannot ignore yourself.'; end if;
 if p_ignored then insert into public.player_ignores values(auth.uid(),p_player_id) on conflict do nothing;
 else delete from public.player_ignores where user_id=auth.uid() and kol_player_id=p_player_id; end if;
end;$$;
create function khub_bot.direct_trade_visible(p_seller uuid,p_escrow boolean) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(p_escrow,false) or auth.uid() is null or p_seller=auth.uid() or not exists(
 select 1 from public.player_ignores i
 join public.profiles seller on seller.id=p_seller
 join public.profiles viewer on viewer.id=auth.uid()
 where (i.user_id=viewer.id and i.kol_player_id=seller.kol_player_id)
 or (i.user_id=seller.id and i.kol_player_id=viewer.kol_player_id));
$$;
create function khub_bot.visible_auctions() returns setof public.auctions
language sql stable security definer set search_path='' as $$
 select a.* from public.auctions a where khub_bot.direct_trade_visible(a.seller_id,a.escrow_mode);
$$;
-- Keep the existing projections, filters, counts, pagination and overloads.
-- A SETOF auctions function preserves the composite type used by projections.
do $$declare f record; d text;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('read_auction_page','read_filtered_auction_page','read_home_auctions',
 'read_seller_auction_context','read_auction_card_context','read_auction_detail_context','read_featured_giveaway') loop
 d:=pg_get_functiondef(f.oid);
 d:=replace(d,'from public.auctions a','from khub_bot.visible_auctions() a');
 execute d;
 end loop;
end;$$;
-- Guard all direct bid and instant purchase entry points, including stale links.
do $$declare name text; args text; callargs text; signature text;
begin
 foreach name in array array['place_bid','purchase_auction'] loop
 args:=case when name='place_bid' then 'p_auction_id uuid,p_amount bigint' else 'p_auction_id uuid' end;
 callargs:=case when name='place_bid' then 'p_auction_id,p_amount' else 'p_auction_id' end;
 signature:=case when name='place_bid' then 'uuid,bigint' else 'uuid' end;
 execute format('alter function public.%I(%s) rename to %I',name,signature,name||'_before_ignores');
 execute format('revoke all on function public.%I(%s) from public,anon,authenticated',name||'_before_ignores',signature);
 execute format('create function public.%I(%s) returns void language plpgsql security definer set search_path='''' as $body$
 begin
 perform pg_advisory_xact_lock(3888760);
 if exists(select 1 from public.auctions a where a.id=p_auction_id and not khub_bot.direct_trade_visible(a.seller_id,a.escrow_mode)) then
 raise exception ''Direct trading is unavailable between these players.''; end if;
 perform public.%I(%s);
 end;$body$',name,args,name||'_before_ignores',callargs);
 execute format('revoke all on function public.%I(%s) from public,anon',name,signature);
 execute format('grant execute on function public.%I(%s) to authenticated',name,signature);
 end loop;
end;$$;
revoke all on function public.read_player_ignores(),public.set_player_ignored(bigint,boolean) from public,anon;
grant execute on function public.read_player_ignores(),public.set_player_ignored(bigint,boolean) to authenticated;
revoke all on function khub_bot.direct_trade_visible(uuid,boolean),khub_bot.visible_auctions() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
