-- Apply once after 287, before deploying the website. No financial rules change.
begin;
alter table public.auctions add column host_message text check (char_length(host_message) <= 500);
alter table khub_bot.barter_auctions add column host_message text check (char_length(host_message) <= 500);

-- Keep creation and the optional message atomic. Existing creators remain the
-- authority for identity, restrictions, assets, prices, fees and deadlines.
create function public.create_listing_with_message(p_listing jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare aid uuid; msg text := nullif(btrim(p_listing->>'hostMessage'), '');
 ending timestamptz := (p_listing->>'customEndAt')::timestamptz;
 hours integer := (p_listing->>'auctionTime')::integer;
 escrow boolean := coalesce((p_listing->>'escrowMode')::boolean, true);
begin
 perform khub_bot.require_verified_trader();
 if char_length(msg) > 500 then raise exception 'Host message must be 500 characters or fewer.'; end if;
 if p_listing->>'auctionKind' = 'barter' then
   perform pg_advisory_xact_lock(hashtextextended((p_listing->>'requestId'),273));
   select id into aid from khub_bot.barter_auctions where request_id = (p_listing->>'requestId')::uuid and seller_id = auth.uid();
   if found then return aid; end if;
   aid := public.create_barter_auction((p_listing->>'itemId')::integer, (p_listing->>'quantity')::bigint,
     (p_listing->>'minBidMeat')::bigint, hours, ending, (p_listing->>'requestId')::uuid);
   -- An idempotent publication retry must not overwrite an existing message.
   update khub_bot.barter_auctions set host_message = msg where id = aid and seller_id = auth.uid() and host_message is null;
   return aid;
 elsif p_listing->>'mrARate' is not null then
   aid := public.create_mr_a_auction(p_listing, (p_listing->>'mrARate')::bigint);
 elsif coalesce((p_listing->>'autoRelist')::boolean, false) then
   aid := public.create_relisting_auction(p_listing, (p_listing->>'relistCount')::integer, (p_listing->>'relistReduction')::integer);
 elsif jsonb_array_length(coalesce(p_listing->'bundleItems', '[]'::jsonb)) > 0 then
   aid := public.create_bundle_auction(p_listing->'bundleItems', (p_listing->>'minBidMeat')::bigint, hours,
     (p_listing->>'instantPurchasePrice')::bigint, escrow, ending, p_listing->>'bundleTitle', (p_listing->>'bundleImageItemId')::integer);
 elsif p_listing->>'auctionKind' = 'buy' then
   aid := public.create_buy_auction((p_listing->>'itemId')::integer, (p_listing->>'quantity')::bigint,
     (p_listing->>'minBidMeat')::bigint, hours, p_listing->>'deliveryMode');
 elsif nullif(p_listing->>'giveawayTitle', '') is not null then
   aid := public.create_giveaway_auction(p_listing->>'item', (p_listing->>'quantity')::bigint,
     (p_listing->>'minBidMeat')::bigint, case when ending is not null and hours = 1 then 6 else hours end,
     p_listing->>'image', (p_listing->>'instantPurchasePrice')::bigint, (p_listing->>'itemId')::integer,
     escrow, p_listing->>'giveawayTitle', ending, coalesce(p_listing->>'giveawayWinCondition', 'last_bid'));
 elsif ending is not null then
   aid := public.create_auction(p_listing->>'item', (p_listing->>'quantity')::bigint, (p_listing->>'minBidMeat')::bigint,
     hours, p_listing->>'image', (p_listing->>'instantPurchasePrice')::bigint, (p_listing->>'itemId')::integer, escrow, ending);
 else
   aid := public.create_auction(p_listing->>'item', (p_listing->>'quantity')::bigint, (p_listing->>'minBidMeat')::bigint,
     hours, p_listing->>'image', (p_listing->>'instantPurchasePrice')::bigint, (p_listing->>'itemId')::integer, escrow);
 end if;
 update public.auctions set host_message = msg where id = aid and seller_id = auth.uid();
 return aid;
end; $$;
revoke all on function public.create_listing_with_message(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_listing_with_message(jsonb) to authenticated;

-- Decorate only rows already authorized by the existing detail readers. Keep
-- messages out of browse projections and shared public snapshot payloads.
do $migration$
declare f record; original text; args text; body text; readers integer := 0;
begin
 for f in select p.oid, p.proname, pg_get_function_arguments(p.oid) as declaration,
   pg_get_function_identity_arguments(p.oid) as identity, p.proargnames
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('read_auction_detail_static', 'read_barter_detail')
 loop
   readers := readers + 1;
   original := f.proname || '_before_288';
   select string_agg(quote_ident(x), ', ') into args from unnest(f.proargnames) as x;
   execute format('alter function public.%I(%s) rename to %I', f.proname, f.identity, original);
   execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role', original, f.identity);
   if f.proname = 'read_barter_detail' then
     body := format('declare result jsonb; begin result := public.%I(%s); if result is null then return null; end if; return result || jsonb_build_object(''hostMessage'', (select host_message from khub_bot.barter_auctions where id = (result->>''id'')::uuid)); end;', original, args);
   else
     body := format('declare result jsonb; begin result := public.%I(%s); return jsonb_set(result, ''{rows}'', coalesce((select jsonb_agg(r.value || jsonb_build_object(''host_message'', a.host_message) order by r.ordinality) from jsonb_array_elements(result->''rows'') with ordinality r(value, ordinality) left join public.auctions a on a.id = (r.value->>''id'')::uuid), ''[]''::jsonb)); end;', original, args);
   end if;
   execute format('create function public.%I(%s) returns jsonb language plpgsql stable security definer set search_path = '''' as %L', f.proname, f.declaration, body);
   execute format('revoke all on function public.%I(%s) from public, anon, authenticated, service_role', f.proname, f.identity);
   execute format('grant execute on function public.%I(%s) to anon, authenticated', f.proname, f.identity);
 end loop;
 if readers <> 2 then raise exception 'Expected both listing detail readers. Apply preceding migrations first.'; end if;
end; $migration$;
commit;
