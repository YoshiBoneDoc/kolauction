-- Stop workers; apply after 142, deploy matching bot, then restart.
-- No elapsed-time rule authorizes repeating a potentially submitted game write.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.closet_recovery_attempts (
    attempt uuid primary key,
    transfer_id uuid not null references khub_bot.closet_transfers(id),
    legacy boolean not null default false,
    before_state jsonb not null,
    armed_at timestamptz,
    state text not null default 'watching' check(state in ('watching','moved','not_attempted','not_moved','review')),
    created_at timestamptz not null default clock_timestamp(),
    deadline timestamptz not null default clock_timestamp()+interval '5 minutes',
    next_check_at timestamptz not null default clock_timestamp()+interval '60 seconds',
    check_id uuid,
    reason text
);
create index closet_recovery_transfer_idx on khub_bot.closet_recovery_attempts(transfer_id,created_at desc);
create index closet_recovery_review_idx on khub_bot.closet_recovery_attempts(transfer_id) where state='review';
create index closet_recovery_due_idx on khub_bot.closet_recovery_attempts(next_check_at) where state='watching';
create table khub_bot.closet_recovery_observations (
    check_id uuid primary key,
    attempt uuid not null references khub_bot.closet_recovery_attempts(attempt),
    observed_at timestamptz not null default clock_timestamp(),
    snapshot jsonb not null,
    outcome text not null
);
create index closet_recovery_observation_attempt_idx on khub_bot.closet_recovery_observations(attempt,observed_at desc);
alter table khub_bot.closet_recovery_attempts enable row level security;
alter table khub_bot.closet_recovery_observations enable row level security;
revoke all on khub_bot.closet_recovery_attempts,khub_bot.closet_recovery_observations from public,anon,authenticated;
grant select on khub_bot.closet_recovery_attempts,khub_bot.closet_recovery_observations to service_role;

create function khub_bot.close_closet_recovery_report(p_id uuid,p_reason text) returns void
language plpgsql set search_path='' as $$
begin
    update khub_bot.bug_reports set status='resolved',resolution_kind='system_resolved',resolved_at=clock_timestamp(),resolved_by=null,
        body=body||E'\n\nAutomatic closet recovery: '||p_reason
        where is_system and status='open' and id in (select report_id from khub_bot.closet_transfer_reviews where transfer_id=p_id);
end;$$;

-- A queued row must never replay an already-authorized unresolved request or
-- an attempt whose durable completion was recorded. Repair only proven ledger
-- completion; quarantine contradictory pending/armed state for investigation.
create function khub_bot.guard_closet_recovery_queue() returns void
language plpgsql set search_path='' as $$
declare x record;
begin
    for x in select c.id,c.moved_at,j.attempt,j.state,j.before_state from khub_bot.closet_transfers c
        cross join lateral (select r.* from khub_bot.closet_recovery_attempts r
            where r.transfer_id=c.id and not r.legacy and r.armed_at is not null and r.state in ('watching','review','moved')
            order by r.created_at desc limit 1) j
        where c.state='pending' for update of c
    loop
        if x.state='moved' then
            update khub_bot.closet_transfers set state='moved',attempt=x.attempt,moved_at=coalesce(moved_at,clock_timestamp()),
                evidence='Automatic ledger repair: this exact attempt already has durable completion proof; no second deposit.' where id=x.id;
        else
            update khub_bot.closet_transfers set state='unknown',attempt=x.attempt,before_state=x.before_state,
                evidence='Queued row conflicts with an authorized unresolved attempt. No repeated deposit allowed.' where id=x.id;
            update khub_bot.closet_recovery_attempts set state='review',reason='Queued row conflicts with an authorized unresolved attempt; operator evidence required.' where attempt=x.attempt;
        end if;
    end loop;
end;$$;

-- A separate versioned claim prevents older workers from accidentally creating
-- a "never submitted" marker without honoring its mandatory pre-request fence.
create function public.bot_claim_closet_transfer_v2(p_snapshot jsonb,p_reserve bigint,p_review_meat bigint,p_review_items jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d jsonb;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.guard_closet_recovery_queue();
    d:=public.bot_claim_closet_transfer(p_snapshot,p_reserve,p_review_meat,p_review_items);
    if d is null then return null;end if;
    insert into khub_bot.closet_recovery_attempts(attempt,transfer_id,before_state)
        values((d->>'attempt')::uuid,(d->>'id')::uuid,d->'before_state');
    return d||jsonb_build_object('closet_recovery_version',1);
end;$$;
create function public.bot_arm_closet_transfer(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    perform 1 from khub_bot.closet_transfers where id=p_id and state='moving' and attempt=p_attempt for update;
    if not found then raise exception 'Closet attempt changed; no game request authorized.';end if;
    update khub_bot.closet_recovery_attempts set armed_at=clock_timestamp(),deadline=clock_timestamp()+interval '5 minutes',
        next_check_at=clock_timestamp()+interval '60 seconds'
        where attempt=p_attempt and transfer_id=p_id and state='watching' and not legacy and armed_at is null;
    if not found then raise exception 'Closet attempt already armed or changed; no repeated game request authorized.';end if;
end;$$;

-- Called only when the client has not entered the game-request call at all,
-- including a lost database response while arming. This is not a classification
-- of a game timeout or redirect. A delayed arm RPC is fenced by the state reset.
create function public.bot_release_unsubmitted_closet(p_id uuid,p_attempt uuid) returns void
language plpgsql security definer set search_path='' as $$
declare j khub_bot.closet_recovery_attempts%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into j from khub_bot.closet_recovery_attempts where attempt=p_attempt and transfer_id=p_id for update;
    if j.state='not_attempted' then return;end if;
    if j.attempt is null or j.legacy or j.state<>'watching' then raise exception 'Cannot release this closet attempt as unsubmitted.';end if;
    perform public.bot_reconcile_closet_transfer(p_id,false,'Automatic recovery: client confirmed no game request was submitted; stale attempt fenced.');
    update khub_bot.closet_recovery_attempts set state='not_attempted',reason='Client exited before any game request; safely returned to pending.' where attempt=p_attempt;
    perform khub_bot.close_closet_recovery_report(p_id,'Client confirmed no game request was submitted.');
end;$$;

create function public.bot_due_closet_recovery() returns jsonb
language plpgsql security definer set search_path='' as $$
declare j khub_bot.closet_recovery_attempts%rowtype; c khub_bot.closet_transfers%rowtype; checks jsonb:='[]';token uuid;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.guard_closet_recovery_queue();
    -- Historical/older-worker attempts have no submission fence. Observe them,
    -- but never infer safe retry or completion from their old snapshot alone.
    insert into khub_bot.closet_recovery_attempts(attempt,transfer_id,before_state,legacy,armed_at,next_check_at)
        select coalesce(src.attempt,src.id),src.id,coalesce(src.before_state,'{}'),true,null,clock_timestamp()
        from khub_bot.closet_transfers src where src.state in ('moving','unknown')
        on conflict(attempt) do nothing;
    for j in select a.* from khub_bot.closet_recovery_attempts a join khub_bot.closet_transfers src on src.id=a.transfer_id
        where a.state='watching' and a.next_check_at<=clock_timestamp() and src.state in ('moving','unknown')
            and coalesce(src.attempt,src.id)=a.attempt
        order by a.next_check_at,a.attempt limit 5 for update of a,src
    loop
        select * into strict c from khub_bot.closet_transfers where id=j.transfer_id;
        if not j.legacy and j.armed_at is null then
            -- Fence the stale claimant before releasing the original obligation.
            -- A late arm RPC will fail; no game request was ever authorized.
            perform public.bot_reconcile_closet_transfer(c.id,false,'Automatic recovery: durable request fence was never armed; no asset request authorized.');
            update khub_bot.closet_recovery_attempts set state='not_attempted',reason='Request was never authorized; queued with original financial safeguards.' where attempt=j.attempt;
            perform khub_bot.close_closet_recovery_report(c.id,'Never-submitted attempt safely returned to pending.');
            checks:=checks||jsonb_build_array(jsonb_build_object('closet_reference','C-'||c.reference_number,'recovery_status','not_attempted'));
            continue;
        end if;
        token:=gen_random_uuid();
        update khub_bot.closet_recovery_attempts set check_id=token,next_check_at=clock_timestamp()+interval '60 seconds' where attempt=j.attempt;
        checks:=checks||jsonb_build_array(khub_bot.closet_transfer_details(c)||jsonb_build_object('check_id',token,'recovery_attempt',j.attempt,
            'legacy',j.legacy,'deadline',j.deadline,'recovery_status','check'));
    end loop;
    return checks;
end;$$;

create function public.bot_record_closet_recovery(p_id uuid,p_attempt uuid,p_check_id uuid,p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c khub_bot.closet_transfers%rowtype;j khub_bot.closet_recovery_attempts%rowtype;observed bigint;prior bigint;amount bigint;
    result text;why text;concurrent integer;read_failed boolean:=p_snapshot->>'read_failed'='true';
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.closet_recovery_observations where check_id=p_check_id and attempt=p_attempt) then
        return jsonb_build_object('status',(select state from khub_bot.closet_recovery_attempts where attempt=p_attempt));end if;
    select * into j from khub_bot.closet_recovery_attempts where attempt=p_attempt and transfer_id=p_id for update;
    select * into c from khub_bot.closet_transfers where id=p_id for update;
    if j.attempt is null or j.state<>'watching' or j.check_id is distinct from p_check_id
        or c.state not in ('moving','unknown') or coalesce(c.attempt,c.id) is distinct from p_attempt then
        raise exception 'Recovery check changed; discard the stale observation.';end if;
    if not coalesce(read_failed,false) then
        if coalesce(p_snapshot->>'inventory','')!~'^[0-9]{1,16}$' or coalesce(p_snapshot->>'closet','')!~'^[0-9]{1,16}$' then raise exception 'Invalid recovery balances.';end if;
        observed:=(p_snapshot->>'closet')::bigint;
    end if;
    if coalesce(j.before_state->>'closet','')~'^[0-9]{1,16}$' then prior:=(j.before_state->>'closet')::bigint;end if;
    amount:=case when c.item_id is null then c.meat else c.quantity end;
    select count(*) into concurrent from khub_bot.closet_transfers x where x.state in ('moving','unknown') and x.item_id is not distinct from c.item_id;
    result:='watching';why:='Read-only checks continue; no additional asset request authorized.';
    if not j.legacy and j.armed_at is not null and concurrent=1 and observed=prior+amount then
        -- Inventory can change through unrelated bids/payouts. This asset's
        -- closet writers are held for this sole attempt; exact closet delta is
        -- the completion proof. No other closet writer/manual session may run.
        result:='moved';why:='Fresh read-only observation confirms the exact closet increase for the sole fenced attempt.';
        perform public.bot_reconcile_closet_transfer(c.id,true,why);
        perform khub_bot.close_closet_recovery_report(c.id,why);
    elsif concurrent<>1 or (observed is not null and prior is not null and observed<>prior and observed<>prior+amount) then
        result:='review';why:='Contradictory/partial closet change or multiple unresolved writers; attribution is ambiguous.';
    elsif clock_timestamp()>=j.deadline then
        result:='review';why:=case when j.legacy then 'Historical attempt has no durable submission fence; elapsed time cannot authorize replay or attribute a later change.'
            else 'Five-minute observation window ended without proof of completion or definite non-execution. No automatic resend.' end;
    end if;
    insert into khub_bot.closet_recovery_observations(check_id,attempt,snapshot,outcome) values(p_check_id,p_attempt,p_snapshot,result);
    update khub_bot.closet_recovery_attempts set state=result,reason=why where attempt=p_attempt;
    return jsonb_build_object('status',result,'reason',why);
end;$$;

alter function public.bot_ack_closet_transfer(uuid,uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_ack_closet_transfer(uuid,uuid,boolean,text) rename to ack_closet_before_recovery;
create function public.bot_ack_closet_transfer(p_id uuid,p_attempt uuid,p_moved boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_moved and exists(select 1 from khub_bot.closet_recovery_attempts a where a.attempt=p_attempt and a.transfer_id=p_id and a.state='moved')
        and exists(select 1 from khub_bot.closet_transfers c where c.id=p_id and c.state='moved') then return;end if;
    perform khub_bot.ack_closet_before_recovery(p_id,p_attempt,p_moved,p_evidence);
    if p_moved then
        update khub_bot.closet_recovery_attempts set state='moved',reason='Immediate transfer read-back acknowledged.' where attempt=p_attempt and transfer_id=p_id;
        perform khub_bot.close_closet_recovery_report(p_id,'Immediate transfer read-back acknowledged.');
    end if;
end;$$;

-- Manual reconciliation and automatic completion retire the exact attempt's
-- schedule as well as its ledger state. Historical jobs cannot accumulate as
-- active watchers or overwrite a later claim after the operator resolves one.
alter function public.bot_reconcile_closet_transfer(uuid,boolean,text) set schema khub_bot;
alter function khub_bot.bot_reconcile_closet_transfer(uuid,boolean,text) rename to reconcile_closet_before_recovery;
create function public.bot_reconcile_closet_transfer(p_id uuid,p_moved boolean,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare original_attempt uuid;
begin
    perform pg_advisory_xact_lock(3888760);
    select coalesce(attempt,id) into original_attempt from khub_bot.closet_transfers where id=p_id for update;
    perform khub_bot.reconcile_closet_before_recovery(p_id,p_moved,p_evidence);
    update khub_bot.closet_recovery_attempts set state=case when p_moved then 'moved' else 'not_moved' end,
        reason='Reconciled in ledger: '||left(p_evidence,1000)
        where transfer_id=p_id and attempt=original_attempt and state in ('watching','review');
    perform khub_bot.close_closet_recovery_report(p_id,'Ledger reconciliation recorded.');
end;$$;

do $$ declare d text;anchor text:=$a$where x.state='pending'$a$;
begin
    d:=pg_get_functiondef('khub_bot.claim_closet_before_source_details(jsonb,bigint,bigint,jsonb)'::regprocedure);
    if strpos(d,anchor)=0 then raise exception 'Unexpected closet claim selector; inspect before applying 143.';end if;
    execute replace(d,anchor,anchor||$b$ and not exists(select 1 from khub_bot.closet_recovery_attempts r
        where r.transfer_id=x.id and not r.legacy and r.armed_at is not null and r.state in ('watching','review','moved'))$b$);
end;$$;

-- Do not raise manual alerts while automated observation is still active.
do $$ declare d text;anchor text:=$a$where state in ('moving','unknown') order by created_at,id$a$;
begin
    d:=pg_get_functiondef('public.bot_isolate_closet_transfers()'::regprocedure);
    if strpos(d,anchor)=0 then raise exception 'Unexpected closet isolation selector; inspect before applying 143.';end if;
    d:=replace(d,'values(c.id) on conflict do nothing;',
        $q$values(c.id) on conflict(transfer_id) do update set report_id=null,created_at=clock_timestamp()
            where exists(select 1 from khub_bot.bug_reports old where old.id=khub_bot.closet_transfer_reviews.report_id and old.status='resolved')
                and exists(select 1 from khub_bot.closet_recovery_attempts latest where latest.transfer_id=c.id and latest.attempt=c.attempt
                    and not latest.legacy and latest.created_at>khub_bot.closet_transfer_reviews.created_at);$q$);
    d:=replace(d,$q$'closet-review:'||c.id,3552305$q$,$q$'closet-review:'||c.id||':'||report,3552305$q$);
    d:=replace(d,'Verify actual inventory and closet balances before resolving moved/not-moved.',
        'Inspect saved attempt/recovery observations. Current balances alone do not prove a past move.');
    execute replace(d,anchor,$b$where state in ('moving','unknown') and not exists(
        select 1 from khub_bot.closet_recovery_attempts r where r.transfer_id=khub_bot.closet_transfers.id
            and r.attempt=coalesce(khub_bot.closet_transfers.attempt,khub_bot.closet_transfers.id) and r.state='watching') order by created_at,id$b$);
end;$$;

alter function public.bot_worker_status() set schema khub_bot;
alter function khub_bot.bot_worker_status() rename to worker_status_before_closet_recovery;
create function public.bot_worker_status() returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.worker_status_before_closet_recovery()||jsonb_build_object('closetRecoveryVersion',1,
        'closetRecoveryReviewKey',coalesce((select string_agg(r.attempt::text,',' order by r.attempt)
            from khub_bot.closet_recovery_attempts r join khub_bot.closet_transfers c on c.id=r.transfer_id
            where r.state='review' and c.state in ('moving','unknown') and coalesce(c.attempt,c.id)=r.attempt),''));
$$;
alter function khub_bot.closet_transfer_details(khub_bot.closet_transfers) rename to closet_details_before_recovery;
create function khub_bot.closet_transfer_details(c khub_bot.closet_transfers) returns jsonb
language sql stable set search_path='' as $$
    select khub_bot.closet_details_before_recovery(c)||jsonb_build_object('recovery',(
        select jsonb_build_object('state',r.state,'reason',r.reason,'deadline',r.deadline,'next_check_at',r.next_check_at,'legacy',r.legacy)
        from khub_bot.closet_recovery_attempts r where r.transfer_id=c.id and r.attempt=coalesce(c.attempt,c.id)
        order by r.created_at desc limit 1));
$$;
alter function public.bot_lookup_closet_transfer(text) set schema khub_bot;
alter function khub_bot.bot_lookup_closet_transfer(text) rename to lookup_closet_before_recovery;
create function public.bot_lookup_closet_transfer(p_reference text) returns jsonb language sql stable security definer set search_path='' as $$
    select d||jsonb_build_object('recovery',(select to_jsonb(r) from khub_bot.closet_recovery_attempts r
        where r.transfer_id=(d->>'id')::uuid order by r.created_at desc,r.attempt limit 1),
        'recovery_observations',coalesce((select jsonb_agg(x) from (select o.observed_at,o.snapshot,o.outcome
            from khub_bot.closet_recovery_observations o join khub_bot.closet_recovery_attempts r using(attempt)
            where r.transfer_id=(d->>'id')::uuid order by o.observed_at desc limit 6) x),'[]'::jsonb))
    from (select khub_bot.lookup_closet_before_recovery(p_reference) d) s;
$$;
revoke all on function khub_bot.guard_closet_recovery_queue(),khub_bot.close_closet_recovery_report(uuid,text),khub_bot.ack_closet_before_recovery(uuid,uuid,boolean,text),
    khub_bot.worker_status_before_closet_recovery(),khub_bot.lookup_closet_before_recovery(text),khub_bot.reconcile_closet_before_recovery(uuid,boolean,text),
    khub_bot.closet_details_before_recovery(khub_bot.closet_transfers),khub_bot.closet_transfer_details(khub_bot.closet_transfers) from public,anon,authenticated,service_role;
revoke all on function public.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb),public.bot_arm_closet_transfer(uuid,uuid),
    public.bot_release_unsubmitted_closet(uuid,uuid),public.bot_due_closet_recovery(),public.bot_record_closet_recovery(uuid,uuid,uuid,jsonb),public.bot_ack_closet_transfer(uuid,uuid,boolean,text),
    public.bot_worker_status(),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.bot_claim_closet_transfer_v2(jsonb,bigint,bigint,jsonb),public.bot_arm_closet_transfer(uuid,uuid),
    public.bot_release_unsubmitted_closet(uuid,uuid),public.bot_due_closet_recovery(),public.bot_record_closet_recovery(uuid,uuid,uuid,jsonb),public.bot_ack_closet_transfer(uuid,uuid,boolean,text),
    public.bot_worker_status(),public.bot_lookup_closet_transfer(text),public.bot_reconcile_closet_transfer(uuid,boolean,text) to service_role;
notify pgrst,'reload schema';
commit;
