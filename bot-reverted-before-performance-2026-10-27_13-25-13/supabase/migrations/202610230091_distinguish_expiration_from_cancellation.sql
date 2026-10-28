-- Apply after 090. Correct lifecycle labels without changing assets or guessing
-- why historical cancelled drafts closed. No Oracle worker rebuild is required.
begin;
select pg_advisory_xact_lock(3888760);
alter table public.auctions add column closure_reason text
    check(closure_reason in ('seller_cancelled','deposit_expired','auction_expired')),
    add column expired_at timestamptz;

create function khub_bot.record_auction_expiration() returns trigger
language plpgsql set search_path='' as $$
begin
    if new.status='expired' and old.status is distinct from 'expired' then
        new.expired_at:=coalesce(new.expired_at,clock_timestamp());
        new.closure_reason:=coalesce(new.closure_reason,case when old.status='pending_escrow' then 'deposit_expired' else 'auction_expired' end);
    end if;
    return new;
end; $$;
create trigger auctions_record_expiration before update of status on public.auctions
    for each row execute function khub_bot.record_auction_expiration();
revoke all on function khub_bot.record_auction_expiration() from public,anon,authenticated,service_role;

-- Both old automatic paths used "cancelled" for missing deposits. Keep their
-- exact timing, deletion/history retention and serialization rules unchanged.
do $patch$
declare target regprocedure; definition text; updated text;
    anchor text:='update public.auctions set status=''cancelled'',cancelled_at=clock_timestamp()';
begin
    foreach target in array array['khub_bot.expire_unfunded_escrow()'::regprocedure,'khub_bot.tick_before_buy_reservations()'::regprocedure]
    loop
        definition:=pg_get_functiondef(target);
        if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
            raise exception 'Unexpected automatic deposit expiration definition: %',target;
        end if;
        updated:=replace(definition,anchor,'update public.auctions set status=''expired'',expired_at=clock_timestamp(),closure_reason=''deposit_expired''');
        execute updated;
    end loop;
end; $patch$;

-- Preserve existing cancellation validation, refunds and reservation protection.
-- Mark an explicit seller/buyer cancellation only after the existing RPC succeeds.
alter function public.cancel_auction(uuid) set schema khub_bot;
alter function khub_bot.cancel_auction(uuid) rename to cancel_before_expiration_reasons;
revoke all on function khub_bot.cancel_before_expiration_reasons(uuid) from public,anon,authenticated,service_role;
create function public.cancel_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.cancel_before_expiration_reasons(p_auction_id);
    update public.auctions a set closure_reason='seller_cancelled' where a.id=p_auction_id and (
        (a.auction_kind='sell' and (a.status='cancelled' or (a.status='settling' and a.settlement_outcome='cancelled')))
        or (a.auction_kind='buy' and exists(select 1 from khub_bot.buy_orders o where o.auction_id=a.id and o.close_reason='cancel')));
end; $$;
revoke all on function public.cancel_auction(uuid) from public,anon;
grant execute on function public.cancel_auction(uuid) to authenticated;

alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to auction_before_expiration_reasons;
revoke all on function khub_bot.auction_before_expiration_reasons(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.auction_before_expiration_reasons(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('closure_reason',a.closure_reason,'expired_at',a.expired_at);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
