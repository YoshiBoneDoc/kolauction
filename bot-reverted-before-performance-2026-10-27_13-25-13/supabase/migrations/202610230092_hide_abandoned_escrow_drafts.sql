-- Apply after 091. Retain closed, never-funded escrow drafts for database review,
-- but omit them from website lists, pagination totals and seller activity counts.
-- No asset changes or worker rebuild/restart required.
begin;
select pg_advisory_xact_lock(3888760);
create function khub_bot.is_abandoned_escrow_draft(a public.auctions) returns boolean
language sql stable set search_path='' as $$
    select a.escrow_mode and a.status in ('cancelled','expired','voided')
        and a.item_escrowed_at is null and coalesce(a.current_bid,0)=0
        and a.highest_bidder_id is null and a.winner_id is null
        and not exists(select 1 from public.bids b where b.auction_id=a.id)
        and not exists(select 1 from khub_bot.buy_orders o where o.auction_id=a.id and o.funding_receipt is not null);
$$;
revoke all on function khub_bot.is_abandoned_escrow_draft(public.auctions) from public,anon,authenticated,service_role;

-- Keep all future expired drafts rather than deleting those without linked rows.
-- Only the existing unfunded/deadline predicate is affected; accepted deposits,
-- bids, seller commitments, refunds and settlement stay with the current paths.
create or replace function khub_bot.expire_unfunded_escrow() returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    update public.auctions a set status='expired',expired_at=clock_timestamp(),closure_reason='deposit_expired'
        where a.escrow_mode and a.status='pending_escrow' and a.item_escrowed_at is null
            and coalesce(a.current_bid,0)=0 and a.created_at<=clock_timestamp()-interval '24 hours'
            and not exists(select 1 from public.bids b where b.auction_id=a.id)
            and not exists(select 1 from khub_bot.buy_orders o where o.auction_id=a.id and o.funding_receipt is not null);
end; $$;

-- Filter in the database before sorting/pagination and before seller aggregation.
-- Even the administrator's ordinary browse/profile lists stay uncluttered.
-- An administrator can still inspect a known auction's exact detail URL.
do $patch$
declare target regprocedure; definition text; updated text; patched integer:=0;
    matching_anchor text:='(a.status<>''pending_escrow'' or a.seller_id=auth.uid() or khub_bot.is_administrator(auth.uid())) and (';
    seller_anchor text:='where p_view=''seller'' and a.seller_id=p_id and ';
begin
    for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='read_auction_page'
    loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,matching_anchor)=0 or strpos(definition,seller_anchor)=0 then
            raise exception 'Unexpected auction reader definition: %',target;
        end if;
        updated:=replace(definition,matching_anchor,
            '(not khub_bot.is_abandoned_escrow_draft(a) or (p_view=''detail'' and khub_bot.is_administrator(auth.uid()))) and '||matching_anchor);
        updated:=replace(updated,seller_anchor,seller_anchor||'not khub_bot.is_abandoned_escrow_draft(a) and ');
        execute updated;patched:=patched+1;
    end loop;
    if patched<>3 then raise exception 'Expected 3 auction readers; found %',patched;end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
