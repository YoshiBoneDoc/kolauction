-- Apply after 073. No bot rebuild/restart is required.
-- Only unfunded, unstarted escrow drafts expire; active auctions are untouched.
begin;
select pg_advisory_xact_lock(3888760);

create index auctions_pending_deposit_expiry_idx on public.auctions(created_at)
    where escrow_mode and status='pending_escrow' and item_escrowed_at is null;

create function khub_bot.expire_unfunded_escrow() returns void
language plpgsql security definer set search_path='' as $$
declare listing uuid;
begin
    -- Same lock as deposits, bids and finalization: a deposit cannot activate a
    -- listing concurrently with its deletion. Processing time decides acceptance.
    perform pg_advisory_xact_lock(3888760);
    for listing in select a.id from public.auctions a
        where a.escrow_mode and a.status='pending_escrow'
            and a.item_escrowed_at is null and coalesce(a.current_bid,0)=0
            and a.created_at<=clock_timestamp()-interval '24 hours'
            and not exists(select 1 from public.bids b where b.auction_id=a.id)
        order by a.id for update of a
    loop
        begin
            delete from public.auctions where id=listing;
        exception when foreign_key_violation then
            -- Retain any linked support/audit/ledger records, without leaving
            -- an expired draft available to accept a deposit. No assets move.
            update public.auctions set status='cancelled',cancelled_at=clock_timestamp()
                where id=listing;
        end;
    end loop;
end; $$;
revoke all on function khub_bot.expire_unfunded_escrow() from public,anon,authenticated,service_role;

-- Ordinary website reads and the bot's existing tick both call this endpoint.
alter function public.finalize_expired_auctions() set schema khub_bot;
alter function khub_bot.finalize_expired_auctions() rename to finalize_before_deposit_expiry;
revoke all on function khub_bot.finalize_before_deposit_expiry() from public,anon,authenticated,service_role;
create function public.finalize_expired_auctions() returns void
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.expire_unfunded_escrow();
    perform khub_bot.finalize_before_deposit_expiry();
end; $$;
revoke all on function public.finalize_expired_auctions() from public;
grant execute on function public.finalize_expired_auctions() to anon,authenticated,service_role;

-- Reject late deposits even if no website request or bot tick has cleaned up
-- the draft yet. The existing validated ingestion path returns its attachments
-- and keeps replay/deduplication, restrictions and financial guards unchanged.
alter function public.bot_ingest_mail(jsonb) set schema khub_bot;
alter function khub_bot.bot_ingest_mail(jsonb) rename to ingest_before_deposit_expiry;
revoke all on function khub_bot.ingest_before_deposit_expiry(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_mail(p_mail jsonb) returns text
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.expire_unfunded_escrow();
    return khub_bot.ingest_before_deposit_expiry(p_mail);
end; $$;
revoke all on function public.bot_ingest_mail(jsonb) from public,anon,authenticated;
grant execute on function public.bot_ingest_mail(jsonb) to service_role;

select khub_bot.expire_unfunded_escrow();
notify pgrst,'reload schema';
commit;
