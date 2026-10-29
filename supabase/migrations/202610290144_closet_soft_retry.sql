-- Owner-authorized closet-only policy: ONE probabilistic retry after five
-- minutes of stable readable observations. This is not proof of non-execution.
-- Apply after 143 with workers stopped, then deploy matching bot.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.closet_recovery_attempts add column soft_retry_window_started_at timestamptz;
alter table khub_bot.closet_recovery_attempts drop constraint closet_recovery_attempts_state_check,
    add constraint closet_recovery_attempts_state_check check(state in ('watching','moved','not_attempted','not_moved','review','soft_retry'));
alter table khub_bot.closet_reconciliations drop constraint closet_reconciliations_resolution_check,
    add constraint closet_reconciliations_resolution_check check(resolution in ('moved','not-moved','soft-retry'));
create table khub_bot.closet_soft_retries (
    transfer_id uuid primary key references khub_bot.closet_transfers(id),
    original_attempt uuid not null references khub_bot.closet_recovery_attempts(attempt),
    retry_attempt uuid references khub_bot.closet_recovery_attempts(attempt),
    item_id integer,amount bigint not null check(amount>0),baseline_closet bigint not null check(baseline_closet>=0),
    status text not null check(status in ('approved','ready','claimed','completed','cancelled','review')),
    approved_at timestamptz not null default clock_timestamp(),revalidated_at timestamptz,used_at timestamptz,
    last_snapshot jsonb,reason text not null
);
create index closet_soft_retries_active_idx on khub_bot.closet_soft_retries(status,item_id) where status in ('approved','ready','claimed');
alter table khub_bot.closet_soft_retries enable row level security;
revoke all on khub_bot.closet_soft_retries from public,anon,authenticated;
grant select on khub_bot.closet_soft_retries to service_role;

alter function public.bot_record_closet_recovery(uuid,uuid,uuid,jsonb) set schema khub_bot;
alter function khub_bot.bot_record_closet_recovery(uuid,uuid,uuid,jsonb) rename to record_closet_before_soft_retry;
create function public.bot_record_closet_recovery(p_id uuid,p_attempt uuid,p_check_id uuid,p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;j khub_bot.closet_recovery_attempts%rowtype;c khub_bot.closet_transfers%rowtype;
    start_at timestamptz;baseline bigint;reads integer;first_read timestamptz;last_read timestamptz;why text;budget khub_bot.closet_soft_retries%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    result:=khub_bot.record_closet_before_soft_retry(p_id,p_attempt,p_check_id,p_snapshot);
    select * into budget from khub_bot.closet_soft_retries where transfer_id=p_id;
    if result->>'status'='moved' then
        update khub_bot.closet_soft_retries set status='completed',reason='Closet transfer confirmed during recovery.' where transfer_id=p_id and retry_attempt=p_attempt;
        return result;
    end if;
    if result->>'status'='soft_retry' then
        return jsonb_build_object('status',case when budget.status in ('completed','cancelled') then 'moved'
            when budget.status='review' then 'review' else 'soft_retry' end,'reason',budget.reason);
    end if;
    if result->>'status'<>'review' then return result;end if;
    if budget.transfer_id is not null then
        if budget.retry_attempt=p_attempt then
            why:='Soft retry 1/1 did not confirm completion. No further automatic closet retry; manual review required.';
            update khub_bot.closet_recovery_attempts set reason=why where attempt=p_attempt;
            update khub_bot.closet_soft_retries set status='review',reason=why where transfer_id=p_id;
            return jsonb_build_object('status','review','reason',why);
        end if;
        return result;
    end if;
    select * into j from khub_bot.closet_recovery_attempts where attempt=p_attempt for update;
    select * into c from khub_bot.closet_transfers where id=p_id for update;
    start_at:=coalesce(j.soft_retry_window_started_at,case when j.legacy then j.created_at else j.armed_at end);
    if c.state not in ('moving','unknown') or coalesce(c.attempt,c.id)<>p_attempt or start_at is null
        or start_at>clock_timestamp()-interval '5 minutes'
        or (j.reason not like 'Five-minute observation window ended%' and j.reason not like 'Historical attempt has no durable submission fence%')
        or coalesce(j.before_state->>'closet','')!~'^[0-9]{1,16}$' then return result;end if;
    baseline:=(j.before_state->>'closet')::bigint;
    -- Require five real, minute-scheduled readable checks spanning at least four
    -- minutes plus the pre-request baseline. Failed or contradictory reads do
    -- not count, and a bad read never grants retry permission.
    select count(*),min(observed_at),max(observed_at) into reads,first_read,last_read
        from (select * from khub_bot.closet_recovery_observations where attempt=p_attempt and observed_at>=start_at
            order by observed_at desc limit 5) recent
        where coalesce(snapshot->>'read_failed','false')='false' and snapshot->>'closet'=baseline::text;
    if exists(select 1 from khub_bot.closet_recovery_observations where attempt=p_attempt
            and coalesce(snapshot->>'read_failed','false')='false' and snapshot->>'closet' is distinct from baseline::text)
        or (select count(*) from khub_bot.closet_transfers where state in ('moving','unknown') and item_id is not distinct from c.item_id)<>1
        then return result;end if;
    if reads<5 or last_read-first_read<interval '4 minutes' or last_read<clock_timestamp()-interval '30 seconds'
        or p_snapshot->>'closet' is distinct from baseline::text then
        -- A temporary failed read is not a deposit failure. Allow a bounded
        -- grace period to obtain five readable scheduled checks; never retry
        -- solely because those reads were unavailable.
        if clock_timestamp()<start_at+interval '10 minutes' then
            update khub_bot.closet_recovery_attempts set state='watching',deadline=clock_timestamp()+interval '60 seconds',
                reason='Waiting for five readable unchanged checks before the one allowed soft retry.' where attempt=p_attempt;
            update khub_bot.closet_recovery_observations set outcome='watching' where check_id=p_check_id;
            return jsonb_build_object('status','watching');
        end if;
        return result;
    end if;
    why:='SOFT RETRY 1/1 approved by closet-only policy after five minutes of unchanged readable closet observations; non-execution is inferred, not proven.';
    insert into khub_bot.closet_soft_retries(transfer_id,original_attempt,item_id,amount,baseline_closet,status,last_snapshot,reason)
        values(c.id,p_attempt,c.item_id,case when c.item_id is null then c.meat else c.quantity end,baseline,'approved',p_snapshot,why);
    update khub_bot.closet_transfers set state='pending',attempt=null,evidence=why where id=c.id;
    update khub_bot.closet_recovery_attempts set state='soft_retry',reason=why where attempt=p_attempt;
    insert into khub_bot.closet_reconciliations(transfer_id,resolution,evidence) values(c.id,'soft-retry',why);
    update khub_bot.closet_recovery_observations set outcome='soft_retry' where check_id=p_check_id;
    return jsonb_build_object('status','soft_retry','reason',why);
end;$$;

-- Only the versioned claim may release an approved retry, after examining a
-- fresh game snapshot. Other pending moves of that asset cannot jump ahead and
-- invalidate the baseline while this retry is waiting.
do $$declare d text;anchor text:=$a$where x.state='pending'$a$;
begin
    d:=pg_get_functiondef('khub_bot.claim_closet_before_source_details(jsonb,bigint,bigint,jsonb)'::regprocedure);
    if strpos(d,anchor)=0 then raise exception 'Unexpected closet selector; inspect before applying 144.';end if;
    execute replace(d,anchor,anchor||$b$ and not exists(select 1 from khub_bot.closet_soft_retries sr
        where sr.transfer_id=x.id and sr.status='approved')
        and not exists(select 1 from khub_bot.closet_soft_retries sr where sr.transfer_id<>x.id
            and sr.item_id is not distinct from x.item_id and sr.status in ('approved','ready','claimed')
            and exists(select 1 from khub_bot.closet_transfers owner where owner.id=sr.transfer_id and owner.state in ('pending','moving','unknown')))$b$);
end;$$;
alter function public.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb) set schema khub_bot;
alter function khub_bot.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb) rename to claim_closet_before_soft_retry;
create function public.bot_claim_closet_transfer_v2(p_snapshot jsonb,p_reserve bigint,p_review_meat bigint,p_review_items jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidate record;observed bigint;current_amount bigint;available numeric;held numeric;liabilities jsonb;compact_snapshot jsonb;d jsonb;
begin
    perform pg_advisory_xact_lock(3888760);
    -- A claim/arm that never entered the game call does not consume the one
    -- actual retry. Its stale marker is already fenced by 143's release path.
    update khub_bot.closet_soft_retries sr set status='approved',retry_attempt=null,used_at=null
        from khub_bot.closet_transfers c,khub_bot.closet_recovery_attempts j
        where c.id=sr.transfer_id and c.state='pending' and j.attempt=sr.retry_attempt and j.state='not_attempted' and sr.status in ('claimed','review');
    for candidate in select sr.*,c.item_id current_item,c.meat,c.quantity from khub_bot.closet_soft_retries sr
        join khub_bot.closet_transfers c on c.id=sr.transfer_id where sr.status='approved' and c.state='pending'
        order by c.created_at,c.id for update of sr,c
    loop
        if candidate.item_id is null then
            if coalesce(p_snapshot->>'closetMeat','')!~'^[0-9]{1,16}$' then raise exception 'Fresh closet snapshot required for soft retry.';end if;
            observed:=(p_snapshot->>'closetMeat')::bigint;
        else observed:=coalesce((p_snapshot#>>array['closetItems',candidate.item_id::text])::bigint,0);end if;
        current_amount:=case when candidate.current_item is null then candidate.meat else candidate.quantity end;
        compact_snapshot:=jsonb_build_object('closet',observed::text,'inventory',case when candidate.item_id is null then p_snapshot->>'meat' else coalesce(p_snapshot#>>array['items',candidate.item_id::text],'0') end);
        if candidate.current_item is distinct from candidate.item_id or current_amount<>candidate.amount
            or observed not in (candidate.baseline_closet,candidate.baseline_closet+candidate.amount) then
            update khub_bot.closet_transfers set state='unknown',attempt=candidate.original_attempt,
                evidence='Closet balance or transfer terms changed before soft retry. No second request authorized.' where id=candidate.transfer_id;
            update khub_bot.closet_recovery_attempts set state='review',reason='Closet balance or transfer terms changed before soft retry.' where attempt=candidate.original_attempt;
            update khub_bot.closet_soft_retries set status='review',reason='Fresh pre-retry check found a change; retry cancelled for review.',last_snapshot=compact_snapshot where transfer_id=candidate.transfer_id;
        elsif observed=candidate.baseline_closet+candidate.amount then
            update khub_bot.closet_transfers set state='moved',attempt=candidate.original_attempt,moved_at=clock_timestamp(),
                evidence='Expected closet increase appeared before soft retry; cancelled the second request.' where id=candidate.transfer_id;
            update khub_bot.closet_recovery_attempts set state='moved',reason='Expected closet increase observed before retry; no second request.' where attempt=candidate.original_attempt;
            update khub_bot.closet_soft_retries set status='cancelled',reason='Original transfer appeared before retry; no second request.',last_snapshot=compact_snapshot where transfer_id=candidate.transfer_id;
            insert into khub_bot.closet_reconciliations(transfer_id,resolution,evidence) values(candidate.transfer_id,'moved','Expected increase appeared before retry; no second game request.');
            perform khub_bot.close_closet_recovery_report(candidate.transfer_id,'Expected increase appeared before retry; completed without another deposit.');
        else
            -- Leave room for BOTH the possible late original and the one retry
            -- without using player escrow/review assets or the operating reserve.
            liabilities:=public.bot_liabilities();
            if candidate.item_id is null then
                available:=(p_snapshot->>'meat')::numeric;
                held:=(liabilities->>'meat')::numeric+p_reserve+p_review_meat;
            else
                available:=coalesce((p_snapshot#>>array['items',candidate.item_id::text])::numeric,0);
                held:=coalesce((liabilities#>>array['items',candidate.item_id::text])::numeric,0)
                    +coalesce((p_review_items->>candidate.item_id::text)::numeric,0);
            end if;
            if available is null or held is null or held<0 or available-held<candidate.amount
                or (held>0 and available-held<candidate.amount::numeric*2) then
                update khub_bot.closet_soft_retries set reason='SOFT RETRY 1/1 waiting for unencumbered headroom for both a late original and the retry; protected funds remain untouched.',last_snapshot=compact_snapshot where transfer_id=candidate.transfer_id;
                continue;
            end if;
            update khub_bot.closet_soft_retries set status='ready',revalidated_at=clock_timestamp(),last_snapshot=compact_snapshot where transfer_id=candidate.transfer_id;
        end if;
    end loop;
    -- The original claim still performs every reserve, review, escrow-liability
    -- and unencumbered-inventory check. Approval does not bypass those checks.
    d:=khub_bot.claim_closet_before_soft_retry(p_snapshot,p_reserve,p_review_meat,p_review_items);
    if d is not null then
        update khub_bot.closet_soft_retries set status='claimed',retry_attempt=(d->>'attempt')::uuid
            where transfer_id=(d->>'id')::uuid and status='ready';
        if found then d:=d||jsonb_build_object('soft_retry',true,'soft_retry_number',1);end if;
    end if;
    update khub_bot.closet_soft_retries set status='approved' where status='ready';
    return d;
end;$$;

alter function public.bot_arm_closet_transfer(uuid,uuid) set schema khub_bot;
alter function khub_bot.bot_arm_closet_transfer(uuid,uuid) rename to arm_closet_before_soft_retry;
create function public.bot_arm_closet_transfer(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.closet_soft_retries where transfer_id=p_id and retry_attempt=p_attempt and status='claimed') then
        if not exists(select 1 from khub_bot.closet_soft_retries where transfer_id=p_id and retry_attempt=p_attempt
            and revalidated_at>=clock_timestamp()-interval '10 seconds') then
            raise exception 'Soft retry snapshot is stale; refresh before submitting.';end if;
        update khub_bot.closet_soft_retries set used_at=clock_timestamp() where transfer_id=p_id and retry_attempt=p_attempt;
    end if;
    perform khub_bot.arm_closet_before_soft_retry(p_id,p_attempt);
end;$$;
alter function public.bot_ack_closet_transfer(uuid,uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_ack_closet_transfer(uuid,uuid,boolean,text) rename to ack_closet_before_soft_retry;
create function public.bot_ack_closet_transfer(p_id uuid,p_attempt uuid,p_moved boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.ack_closet_before_soft_retry(p_id,p_attempt,p_moved,p_evidence);
    if p_moved then update khub_bot.closet_soft_retries set status='completed',reason='Soft retry completed and acknowledged.'
        where transfer_id=p_id and retry_attempt=p_attempt;end if;
end;$$;

-- Reconciliation never resets the lifetime soft-retry allowance. It does
-- release asset holds when an operator/automatic proof finishes the obligation.
alter function public.bot_reconcile_closet_transfer(uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_reconcile_closet_transfer(uuid,boolean,text) rename to reconcile_closet_before_soft_retry;
create function public.bot_reconcile_closet_transfer(p_id uuid,p_moved boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.reconcile_closet_before_soft_retry(p_id,p_moved,p_evidence);
    update khub_bot.closet_soft_retries set status=case when p_moved then 'completed' else 'review' end,
        reason=case when p_moved then 'Transfer reconciled as completed.' else 'Reconciled not-moved; the one-time soft-retry allowance is not reset.' end
        where transfer_id=p_id;
end;$$;

alter function khub_bot.closet_transfer_details(khub_bot.closet_transfers) rename to closet_details_before_soft_retry;
create function khub_bot.closet_transfer_details(c khub_bot.closet_transfers) returns jsonb language sql stable set search_path='' as $$
    select khub_bot.closet_details_before_soft_retry(c)||jsonb_build_object('soft_retry',(
        select to_jsonb(sr) from khub_bot.closet_soft_retries sr where sr.transfer_id=c.id));
$$;
alter function public.bot_lookup_closet_transfer(text) set schema khub_bot;
alter function khub_bot.bot_lookup_closet_transfer(text) rename to lookup_closet_before_soft_retry;
create function public.bot_lookup_closet_transfer(p_reference text) returns jsonb language sql stable security definer set search_path='' as $$
    select d||jsonb_build_object('soft_retry',(select to_jsonb(sr) from khub_bot.closet_soft_retries sr where sr.transfer_id=(d->>'id')::uuid))
        from (select khub_bot.lookup_closet_before_soft_retry(p_reference) d) s;
$$;
-- Existing 143 unchanged-window reviews (including legacy attempts) receive a
-- fresh five-minute observation window under the owner's newly approved policy.
-- Existing readings, queued dates and original request timestamps stay intact.
update khub_bot.closet_recovery_attempts j set state='watching',soft_retry_window_started_at=clock_timestamp(),
    deadline=clock_timestamp()+interval '5 minutes',next_check_at=clock_timestamp(),
    reason='Fresh observation window for the newly authorized one-time closet soft retry.'
    from khub_bot.closet_transfers c where c.id=j.transfer_id and c.state in ('moving','unknown')
        and coalesce(c.attempt,c.id)=j.attempt and j.state='review'
        and (j.reason like 'Five-minute observation window ended%' or j.reason like 'Historical attempt has no durable submission fence%')
        and coalesce(j.before_state->>'closet','')~'^[0-9]{1,16}$'
        and not exists(select 1 from khub_bot.closet_soft_retries sr where sr.transfer_id=c.id)
        and not exists(select 1 from khub_bot.closet_recovery_observations o where o.attempt=j.attempt
            and coalesce(o.snapshot->>'read_failed','false')='false' and o.snapshot->>'closet' is distinct from j.before_state->>'closet');

revoke all on function khub_bot.record_closet_before_soft_retry(uuid,uuid,uuid,jsonb),khub_bot.claim_closet_before_soft_retry(jsonb,bigint,bigint,jsonb),
    khub_bot.arm_closet_before_soft_retry(uuid,uuid),khub_bot.ack_closet_before_soft_retry(uuid,uuid,boolean,text),
    khub_bot.reconcile_closet_before_soft_retry(uuid,boolean,text),
    khub_bot.closet_details_before_soft_retry(khub_bot.closet_transfers),khub_bot.closet_transfer_details(khub_bot.closet_transfers),khub_bot.lookup_closet_before_soft_retry(text)
    from public,anon,authenticated,service_role;
revoke all on function public.bot_record_closet_recovery(uuid,uuid,uuid,jsonb),public.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb),
    public.bot_arm_closet_transfer(uuid,uuid),public.bot_ack_closet_transfer(uuid,uuid,boolean,text),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.bot_record_closet_recovery(uuid,uuid,uuid,jsonb),public.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb),
    public.bot_arm_closet_transfer(uuid,uuid),public.bot_ack_closet_transfer(uuid,uuid,boolean,text),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text) to service_role;
notify pgrst,'reload schema';
commit;
