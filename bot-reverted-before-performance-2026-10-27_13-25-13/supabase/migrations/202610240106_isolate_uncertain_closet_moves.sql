-- Stop the worker, apply after 105, then deploy/rebuild the matching worker.
-- Uncertain closet moves remain unresolved and are NEVER automatically retried.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.closet_transfer_reviews (
    transfer_id uuid primary key references khub_bot.closet_transfers(id),
    report_id uuid references khub_bot.bug_reports(id),
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.closet_transfer_reviews enable row level security;
revoke all on khub_bot.closet_transfer_reviews from public,anon,authenticated;
grant all on khub_bot.closet_transfer_reviews to service_role;
create function public.bot_isolate_closet_transfers() returns void
language plpgsql security definer set search_path='' as $$
declare c khub_bot.closet_transfers%rowtype; report uuid; number bigint; alert uuid; body text;
begin
    perform pg_advisory_xact_lock(3888760);
    for c in select * from khub_bot.closet_transfers where state in ('moving','unknown') order by created_at,id loop
        insert into khub_bot.closet_transfer_reviews(transfer_id) values(c.id) on conflict do nothing;
        if not found then continue;end if;
        body:='Closet transfer C-'||c.reference_number||' needs balance reconciliation.'||E'\nTransfer UUID: '||c.id
            ||E'\nSource: '||c.source||E'\nMeat: '||c.meat||E'\nItem: '||coalesce(c.item_id::text,'none')||' x '||c.quantity
            ||E'\n\nThis move may already have happened and will not be retried automatically. Other funded deliveries and unrelated closet assets continue. Moves of this same asset stay paused to preserve balance evidence.'
            ||E'\nVerify actual inventory and closet balances before resolving moved/not-moved. Closing this ticket does not reconcile the transfer.';
        insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,is_system)
            values(gen_random_uuid(),null,'kHub bot',3888760,body,'other',true) returning id,report_number into report,number;
        update khub_bot.closet_transfer_reviews set report_id=report where transfer_id=c.id;
        body:='Closet transfer C-'||c.reference_number||' set aside for balance review (B-'||number||'). Other funded deliveries continue. Administrator inbox: /admin/inbox?category=other';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('closet-review:'||c.id,3552305,'notice',body,body,'') returning id into alert;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(report,alert);
    end loop;
end;$$;

-- Preserve the current dispatcher chain, gift isolation and mailbox protections.
do $$declare d text; target text;
begin
    d:=pg_get_functiondef('khub_bot.claim_before_buy_batching(integer)'::regprocedure);
    target:=$t$    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then raise exception 'Uncertain closet transfer requires reconciliation.'; end if;$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected delivery claim guard.';end if;
    execute replace(d,target,'');
    d:=pg_get_functiondef('public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb)'::regprocedure);
    target:=$t$if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown'))
       or exists$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected closet claim guard.';end if;
    d:=replace(d,target,'if exists');
    target:=$t$select * into d from khub_bot.closet_transfers where state='pending' order by created_at,id limit 1 for update;$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected closet queue.';end if;
    execute replace(d,target,$t$select x.* into d from khub_bot.closet_transfers x where x.state='pending'
        and not exists(select 1 from khub_bot.closet_transfers u where u.state in ('moving','unknown') and u.item_id is not distinct from x.item_id)
        order by x.created_at,x.id limit 1 for update;$t$);
    -- An unrelated uncertain closet asset cannot block opening every gift.
    -- Keep the existing same-wrapper exclusion and full protected-funds budget.
    d:=pg_get_functiondef('public.bot_claim_gift_open(jsonb)'::regprocedure);
    target:=$t$if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then return null;end if;$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected gift opening guard.';end if;
    execute replace(d,target,'');
end;$$;

alter function public.bot_inspect() rename to inspect_before_closet_isolation;
alter function public.inspect_before_closet_isolation() set schema khub_bot;
revoke all on function khub_bot.inspect_before_closet_isolation() from public,anon,authenticated,service_role;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
select khub_bot.inspect_before_closet_isolation()||jsonb_build_object('closetIsolationVersion',1);
$$;
revoke all on function public.bot_isolate_closet_transfers(),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_isolate_closet_transfers(),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
