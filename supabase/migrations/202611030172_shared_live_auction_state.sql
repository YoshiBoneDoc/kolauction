-- Apply after 171. Deploy the compatible invalidation receiver BEFORE this SQL.
-- Enable LIVE_AUCTION_STATE only after deploying the unavailable-state frontend.
-- Display reads only; existing financial lock, bid validation and ledger are unchanged.
begin;
set local lock_timeout='2s';
create function public.read_public_auction_live_batch(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if p_ids is null or cardinality(p_ids)>120 or array_position(p_ids,null) is not null then
        raise exception 'Choose at most 120 public auctions.';
    end if;
    return (select jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),
        'bids','[]'::jsonb,'total',count(*),'rows',coalesce(jsonb_agg(
        (select jsonb_object_agg(key,value) from jsonb_each(to_jsonb(a)) where key in (
            'id','current_bid','end_time','status','instant_purchase_price','instant_purchased_at',
            'final_price','finalized_at','completed_at','cancelled_at','expired_at','closure_reason',
            'escrow_timing_review','ban_review_required'))
        ||jsonb_build_object('bid_count',(select count(*) from public.bids b where b.auction_id=a.id),
            'has_winner',a.winner_id is not null,'receipt_time_bidding',a.escrow_mode,
            'bid_deadline',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time) else a.end_time end,
            'finalization_not_before',case when a.escrow_mode then coalesce(a.escrow_buyout_received_at,a.end_time)+interval '60 seconds' end,
            'bidding_restricted',a.status='active' and khub_bot.profile_is_restricted(a.seller_id))
        ||case when a.auction_kind='buy' then coalesce((select jsonb_build_object(
            'price_per_item',a.min_bid_meat,'purchased_quantity',o.purchased_quantity,
            'remaining_quantity',greatest(0,a.quantity-o.purchased_quantity-o.reduced_quantity),
            'available_quantity',khub_bot.buy_available(a.id),
            'reserved_quantity',coalesce((select sum(quantity) from khub_bot.buy_reservations where auction_id=a.id and state='active'),0),
            'reduced_quantity',o.reduced_quantity,'delivery_mode',o.delivery_mode,'buy_closing_reason',o.close_reason)
            from khub_bot.buy_orders o where o.auction_id=a.id),'{}'::jsonb) else '{}'::jsonb end
        order by a.id),'[]'::jsonb))
        from public.auctions a where a.id=any(p_ids) and a.status<>'pending_escrow'
            and not khub_bot.is_abandoned_escrow_draft(a));
end;$$;
revoke all on function public.read_public_auction_live_batch(uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.read_public_auction_live_batch(uuid[]) to anon,authenticated;

-- v2 signs the public auction UUID as well as revision. No bidder, amounts or
-- private assets enter notifications. Unscoped owner retries retain v1 semantics.
create function khub_bot.send_public_cache_invalidation(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare cfg khub_bot.public_cache_webhook_config%rowtype; rev bigint;
    crypto_schema text; signature text; request_id bigint; payload jsonb; message text;
begin
    select * into cfg from khub_bot.public_cache_webhook_config where id;
    if not found then return;end if;
    select revision into rev from khub_bot.public_cache_revision where id;
    begin
        select n.nspname into crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pgcrypto';
        message:=case when p_auction_id is null then 'khub-public-auctions:v1:'||rev::text
            else 'khub-public-auctions:v2:'||rev::text||':'||p_auction_id::text end;
        execute format('select encode(%I.hmac($1,$2,''sha256''),''hex'')',crypto_schema)
            into signature using message,cfg.signing_secret;
        payload:=jsonb_build_object('revision',rev::text,'signature',signature);
        if p_auction_id is not null then payload:=payload||jsonb_build_object('auction_id',p_auction_id);end if;
        execute 'select net.http_post(url:=$1,body:=$2,headers:=$3,timeout_milliseconds:=3000)'
            into request_id using cfg.endpoint,payload,jsonb_build_object('Content-Type','application/json');
        update khub_bot.public_cache_revision set last_request_id=request_id,last_queued_revision=rev,last_error_code=null where id;
    exception when others then
        update khub_bot.public_cache_revision set enqueue_failures=enqueue_failures+1,last_error_code=sqlstate where id;
    end;
end;$$;
create or replace function khub_bot.send_public_cache_invalidation() returns void
language plpgsql security definer set search_path='' as $$
begin perform khub_bot.send_public_cache_invalidation(null::uuid);end;$$;
create or replace function khub_bot.invalidate_public_cache_after_bid() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    update khub_bot.public_cache_revision set revision=revision+1 where id;
    perform khub_bot.send_public_cache_invalidation(new.auction_id);
    return null;
end;$$;
revoke all on function khub_bot.send_public_cache_invalidation(uuid),khub_bot.send_public_cache_invalidation(),khub_bot.invalidate_public_cache_after_bid() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
