-- Apply after 126 on the website database (standalone bot: after 123).
-- Stop the worker before applying, then deploy the matching bot.
-- Rerunnable. Existing unknown sends/reviews are NEVER automatically released.
begin;
select pg_advisory_xact_lock(3888760);

-- Frozen Sell commissions belong to the bot but are not yet spendable income.
-- Once queued, the closet ledger protects them instead. Count each exactly once.
create or replace function khub_bot.unqueued_sell_commission_meat() returns numeric
language sql stable set search_path='' as $$
    select coalesce(sum(a.fee_meat),0) from public.auctions a
    where a.auction_kind='sell' and a.escrow_mode and a.status='settling' and a.settlement_outcome='completed'
        and not exists(select 1 from khub_bot.closet_transfers c
            where c.auction_id=a.id and c.source='sale_fee' and c.state<>'cancelled');
$$;
revoke all on function khub_bot.unqueued_sell_commission_meat() from public,anon,authenticated,service_role;

create or replace function public.bot_gift_wrapping_liabilities() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_set(held,'{meat}',to_jsonb(((held->>'meat')::numeric
        +coalesce((select sum(c.meat) from khub_bot.closet_transfers c where c.state in ('pending','moving','unknown')),0)
        +khub_bot.unqueued_sell_commission_meat())::text)) from (select public.bot_liabilities() held) protected;
$$;

-- The same commissions must be excluded from unknown surplus, from the verified
-- pre-opening operating quota, and from funds used to verify incoming contents.
do $patch$
declare d text; anchor text;
begin
    d:=pg_get_functiondef('public.bot_refresh_gift_protection(jsonb)'::regprocedure);
    if strpos(d,'unqueued_sell_commission_meat')=0 then
        anchor:='-closet_meat-quota-operating_reserve';
        if strpos(d,anchor)=0 then raise exception 'Unexpected gift protection function; inspect before applying 127.';end if;
        execute replace(d,anchor,'-closet_meat-khub_bot.unqueued_sell_commission_meat()-quota-operating_reserve');
    end if;
    d:=pg_get_functiondef('public.bot_claim_gift_open(jsonb)'::regprocedure);
    if strpos(d,'unqueued_sell_commission_meat')=0 then
        anchor:='-coalesce((p_snapshot->>''reserve'')::bigint,0)';
        if strpos(d,anchor)=0 then raise exception 'Unexpected gift opening claim; inspect before applying 127.';end if;
        execute replace(d,anchor,'-khub_bot.unqueued_sell_commission_meat()'||anchor);
    end if;
    d:=pg_get_functiondef('public.bot_finish_gift_open(uuid,jsonb,jsonb)'::regprocedure);
    if strpos(d,'unqueued_sell_commission_meat')=0 then
        anchor:='+coalesce((select sum(meat) from khub_bot.closet_transfers where state in (''pending'',''moving'',''unknown'')),0) then raise exception ''Gift Meat not secured.''';
        if strpos(d,anchor)=0 then raise exception 'Unexpected gift verification function; inspect before applying 127.';end if;
        execute replace(d,anchor,'+khub_bot.unqueued_sell_commission_meat()'||anchor);
    end if;
end;
$patch$;

-- A known non-attempt can wait safely. A timeout AFTER a game request cannot.
create table if not exists khub_bot.gift_preparation_deferrals (
    delivery_id uuid not null references khub_bot.deliveries(id), attempt uuid not null,
    stage text not null, created_at timestamptz not null default clock_timestamp(),
    primary key(delivery_id,attempt)
);
create table if not exists khub_bot.gift_delivery_waits (
    delivery_id uuid primary key references khub_bot.deliveries(id),
    retry_after timestamptz not null, failures integer not null check(failures>0), stage text not null
);
alter table khub_bot.gift_preparation_deferrals enable row level security;
alter table khub_bot.gift_delivery_waits enable row level security;
revoke all on khub_bot.gift_preparation_deferrals,khub_bot.gift_delivery_waits from public,anon,authenticated;
grant select on khub_bot.gift_preparation_deferrals,khub_bot.gift_delivery_waits to service_role;

create or replace function public.bot_defer_unattempted_gift(p_id uuid,p_attempt uuid,p_diagnostic jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.deliveries%rowtype; stage text:=p_diagnostic->>'stage'; failures integer;
begin
    perform pg_advisory_xact_lock(3888760);
    if p_diagnostic->>'outcome' is distinct from 'not_attempted' or stage is null or stage not in (
        'worker_stopping','inbox_attachment_review','wrapping_inventory_snapshot','wrapping_liabilities','wrapping_solvency',
        'safe_wrapping_authorization','gift_identity','gift_rollover','wrapping_authorization','gift_preparation','buy_wrapping_budget') then
        raise exception 'Only a proven pre-request gift failure may be deferred.';
    end if;
    -- Idempotent after a lost database response, without altering a later claim.
    if exists(select 1 from khub_bot.gift_preparation_deferrals where delivery_id=p_id and attempt=p_attempt) then return;end if;
    select * into d from khub_bot.deliveries where id=p_id for update;
    if not found or d.state<>'sending' or d.attempt is distinct from p_attempt then raise exception 'Gift deferral claim changed; inspect before acting.';end if;
    perform public.bot_release_safe_gift_wrapping(p_id,p_attempt);
    if d.kind='sale_item' and d.dedupe_key like 'buy-%' then
        -- Retain the established Buy batching and packaging-budget behavior.
        perform public.bot_defer_buy_delivery(p_id,p_attempt);
    else
        update khub_bot.deliveries set state='pending',attempt=null,
            evidence='Gift request NOT attempted; preparation deferred at '||stage||'. Assets remain owed and reserved.' where id=p_id;
    end if;
    insert into khub_bot.gift_preparation_deferrals(delivery_id,attempt,stage) values(p_id,p_attempt,stage);
    if d.kind='sale_item' and d.dedupe_key like 'buy-%' then return;end if;
    select coalesce(w.failures,0)+1 into failures from (select 1) x left join khub_bot.gift_delivery_waits w on w.delivery_id=p_id;
    insert into khub_bot.gift_delivery_waits(delivery_id,retry_after,failures,stage)
        values(p_id,clock_timestamp()+make_interval(secs=>least(300,60*power(2,least(failures-1,3)))::integer),failures,stage)
        on conflict(delivery_id) do update set retry_after=excluded.retry_after,failures=excluded.failures,stage=excluded.stage;
end;
$$;
revoke all on function public.bot_defer_unattempted_gift(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.bot_defer_unattempted_gift(uuid,uuid,jsonb) to service_role;

create or replace function khub_bot.clear_completed_gift_wait() returns trigger language plpgsql set search_path='' as $$
begin
    delete from khub_bot.gift_delivery_waits where delivery_id=new.id;
    return new;
end;
$$;
revoke all on function khub_bot.clear_completed_gift_wait() from public,anon,authenticated,service_role;
drop trigger if exists clear_completed_gift_wait on khub_bot.deliveries;
create trigger clear_completed_gift_wait after update of state on khub_bot.deliveries
    for each row when(new.state in ('sent','cancelled')) execute function khub_bot.clear_completed_gift_wait();

-- Patch the actual selector inside the existing versioned claim chain. Keep all
-- financial locks, isolation guards, preparation reviews and Buy waits intact.
do $patch$
declare d text; anchor text:='where x.state=''pending''';
begin
    d:=pg_get_functiondef('khub_bot.claim_before_buy_batching(integer)'::regprocedure);
    if strpos(d,'khub_bot.gift_delivery_waits')=0 then
        if strpos(d,anchor)=0 then raise exception 'Unexpected delivery selector; inspect before applying 127.';end if;
        execute replace(d,anchor,anchor||' and not exists(select 1 from khub_bot.gift_delivery_waits w where w.delivery_id=x.id and w.retry_after>clock_timestamp())');
    end if;
end;
$patch$;

-- Only unsettled attention is needed by the worker. Never count all sent rows,
-- inspect every saved message, or serialize credentials/receipt payloads here.
create index if not exists deliveries_uncertain_worker_idx on khub_bot.deliveries(id) where state in ('sending','unknown');
create index if not exists closet_uncertain_worker_idx on khub_bot.closet_transfers(id) where state in ('moving','unknown');
create or replace function public.bot_worker_status() returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object('workerStatusVersion',1,'giftPreparationDeferralVersion',1,
    'mailboxRecoveryEnabled',true,'closetIsolationVersion',1,'giftIsolationVersion',1,
    'incomingGiftsVersion',2,'receiptTimeBiddingVersion',1,'mailReplayOptimizationVersion',1,'buyDeliveryBatchingVersion',1,
    'attention',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'delivery_reference','D-'||d.reference_number,
        'state',d.state,'attempt',d.attempt)) from khub_bot.deliveries d where d.state in ('sending','unknown')),'[]'::jsonb),
    'isolatedDeliveryAttention',coalesce((select jsonb_agg(jsonb_build_object('id',d.id)) from khub_bot.deliveries d
        join khub_bot.delivery_mailbox_reviews r on r.delivery_id=d.id and r.attempt is not distinct from d.attempt
        where d.state='unknown' and r.resolved_at is null),'[]'::jsonb),
    'closetAttention',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'closet_reference','C-'||c.reference_number,
        'state',c.state,'attempt',c.attempt)) from khub_bot.closet_transfers c where c.state in ('moving','unknown')),'[]'::jsonb),
    'mailPolicyAttention',case when exists(select 1 from khub_bot.mail_policy_reviews where not refund_queued) then '[{}]'::jsonb else '[]'::jsonb end,
    'accountRequestsPending',case when exists(select 1 from khub_bot.account_jobs where state='pending') then 1 else 0 end);
$$;
revoke all on function public.bot_worker_status() from public,anon,authenticated;
grant execute on function public.bot_worker_status() to service_role;

-- Keep the complete operator inspection available, with visible preparation
-- waits. No historical review is closed or converted to a retry by this upgrade.
create or replace function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_intake_performance()||jsonb_build_object('mailReplayOptimizationVersion',1,
        'giftPreparationDeferralVersion',1,
        'giftPreparationWaits',coalesce((select jsonb_agg(jsonb_build_object(
            'delivery_reference','D-'||d.reference_number,'stage',w.stage,'retry_after',w.retry_after,'failures',w.failures)
            order by w.retry_after,d.id) from khub_bot.gift_delivery_waits w join khub_bot.deliveries d on d.id=w.delivery_id
            where d.state='pending'),'[]'::jsonb));
$$;

notify pgrst,'reload schema';
commit;
