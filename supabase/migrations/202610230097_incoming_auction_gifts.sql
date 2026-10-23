-- Apply after 096 with the bot stopped; install the matching worker before restart.
-- Original gift envelopes, verified contents and each opening attempt are retained.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.incoming_gifts (
    mail_id text primary key check(mail_id ~ '^[1-9][0-9]*$'),
    wrapper_id integer not null check(wrapper_id in (1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1460,1534,2683,3430)),
    envelope jsonb not null, payload jsonb, legacy_donation boolean not null default false,
    created_at timestamptz not null default clock_timestamp(), opened_at timestamptz
);
create table khub_bot.gift_open_attempts (
    id uuid primary key default gen_random_uuid(), wrapper_id integer not null,
    state text not null default 'opening' check(state in ('opening','verified','not_opened')),
    before_state jsonb not null, after_state jsonb, mail_id text references khub_bot.incoming_gifts(mail_id),
    evidence text, created_at timestamptz not null default clock_timestamp(), resolved_at timestamptz
);
create unique index one_gift_open_at_a_time on khub_bot.gift_open_attempts((true)) where state='opening';
alter table khub_bot.incoming_gifts enable row level security;
alter table khub_bot.gift_open_attempts enable row level security;
revoke all on khub_bot.incoming_gifts,khub_bot.gift_open_attempts from public,anon,authenticated;

create function public.bot_gift_intake_state() returns jsonb
language sql security definer set search_path='' as $$
select jsonb_build_object('attempt',(select to_jsonb(a) from khub_bot.gift_open_attempts a where state='opening'),
    'legacy_ids',coalesce((select jsonb_agg(mail_id) from khub_bot.receipts where payload#>>'{raw,type}'='giftshop' and result='donation'),'[]'),
    'mails',coalesce((select jsonb_agg(jsonb_build_object('id',mail_id,'wrapper_id',wrapper_id,'raw',envelope,
        'payload',payload,'legacy_donation',legacy_donation,'posted',exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)) order by mail_id::bigint) from khub_bot.incoming_gifts g),'[]'));
$$;
create function public.bot_register_gift_mail(p_envelopes jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e jsonb; prior khub_bot.incoming_gifts%rowtype; r khub_bot.receipts%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    if jsonb_typeof(p_envelopes) is distinct from 'array' then raise exception 'Invalid gift envelope list.';end if;
    for e in select value from jsonb_array_elements(p_envelopes) loop
        if e#>>'{raw,type}' is distinct from 'giftshop' or e->>'id' is distinct from e#>>'{raw,id}'
            or (e#>>'{raw,fromid}')::bigint<=0 or (e#>>'{raw,fromid}')::bigint=3888760
            or e#>>'{raw,fromname}' is null or e#>>'{raw,azunixtime}' is null then raise exception 'Invalid gift identity.';end if;
        select * into prior from khub_bot.incoming_gifts where mail_id=e->>'id';
        if found then
            if (e->>'wrapper_id' is not null and prior.wrapper_id<>(e->>'wrapper_id')::integer)
                or prior.envelope->>'fromid' is distinct from e#>>'{raw,fromid}'
                or prior.envelope->>'fromname' is distinct from e#>>'{raw,fromname}'
                or prior.envelope->>'azunixtime' is distinct from e#>>'{raw,azunixtime}' then raise exception 'Gift identity changed; reconcile.';end if;
            continue;
        end if;
        select * into r from khub_bot.receipts where mail_id=e->>'id';
        if found and (r.result<>'donation' or r.payload#>>'{raw,type}'<>'giftshop') then raise exception 'Gift already has an incompatible receipt.';end if;
        if (e->>'opened')::boolean is distinct from false then
            -- Historical donations may already be opened/closeted manually.
            -- Preserve their original receipts; do not invent a second deposit.
            if r.mail_id is not null then continue;end if;
            raise exception 'Previously opened, untracked gift needs manual review.';
        end if;
        insert into khub_bot.incoming_gifts(mail_id,wrapper_id,envelope,legacy_donation)
            values(e->>'id',(e->>'wrapper_id')::integer,e->'raw',r.mail_id is not null);
    end loop;
    return public.bot_gift_intake_state();
end; $$;
create function public.bot_claim_gift_open(p_snapshot jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a khub_bot.gift_open_attempts%rowtype; g khub_bot.incoming_gifts%rowtype; held bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.gift_open_attempts where state='opening') then raise exception 'A gift open is unresolved; never retry it.';end if;
    if exists(select 1 from khub_bot.deliveries where state in ('sending','unknown'))
        or exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then raise exception 'Resolve uncertain transfers before opening gifts.';end if;
    select * into g from khub_bot.incoming_gifts where payload is null
        and (not legacy_donation or coalesce((p_snapshot#>>array['items',wrapper_id::text])::bigint,0)>0) order by (envelope->>'azunixtime')::bigint,mail_id::bigint limit 1;
    if not found then return null;end if;
    held:=coalesce((public.bot_liabilities()#>>array['items',g.wrapper_id::text])::bigint,0)
        +coalesce((select sum(quantity) from khub_bot.closet_transfers where item_id=g.wrapper_id and state='pending'),0);
    if held>0 or coalesce((p_snapshot#>>array['items',g.wrapper_id::text])::bigint,0)<=0 then
        raise exception 'Gift wrapper is missing or committed elsewhere; reconcile before opening.';
    end if;
    insert into khub_bot.gift_open_attempts(wrapper_id,before_state) values(g.wrapper_id,p_snapshot) returning * into a;
    return to_jsonb(a);
end; $$;
create function public.bot_finish_gift_open(p_attempt uuid,p_mail jsonb,p_snapshot jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare a khub_bot.gift_open_attempts%rowtype; g khub_bot.incoming_gifts%rowtype; x jsonb; needed bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from khub_bot.gift_open_attempts where id=p_attempt for update;
    if not found then raise exception 'Unknown gift open attempt.';end if;
    select * into g from khub_bot.incoming_gifts where mail_id=p_mail->>'id' for update;
    if a.state='verified' and a.mail_id=g.mail_id and g.payload=p_mail then return;end if;
    if a.state<>'opening' or g.mail_id is null or g.payload is not null or a.wrapper_id<>g.wrapper_id
        or p_mail#>>'{raw,type}' is distinct from 'normal' or p_mail#>>'{raw,gift_original,type}' is distinct from 'giftshop'
        or p_mail#>>'{raw,gift_original,id}' is distinct from g.mail_id
        or p_mail#>>'{raw,gift_original,fromid}' is distinct from g.envelope->>'fromid'
        or p_mail#>>'{raw,gift_original,fromname}' is distinct from g.envelope->>'fromname'
        or p_mail#>>'{raw,gift_original,azunixtime}' is distinct from g.envelope->>'azunixtime'
        or p_mail->>'sender_id' is distinct from g.envelope->>'fromid'
        or p_mail->>'sender_name' is distinct from g.envelope->>'fromname'
        or (p_mail->>'received_at')::timestamptz is distinct from to_timestamp((g.envelope->>'azunixtime')::bigint)
        or strpos(coalesce(p_mail#>>'{raw,gift_original,message}',''),'<p>Inside Note:<p>')=0
        or p_mail->>'meat' is null or (p_mail->>'meat')::numeric not between 0 and 9007199254740991
        or jsonb_typeof(p_snapshot->'items') is distinct from 'object' or p_snapshot->>'meat' is null
        or jsonb_typeof(p_mail->'items') is distinct from 'array' then raise exception 'Gift proof does not match the original envelope.';end if;
    if exists(select 1 from jsonb_array_elements(p_mail->'items') v where v->>'id' is null or (v->>'id')::integer<=0
        or v->>'quantity' is null or (v->>'quantity')::bigint not between 1 and 5000000000)
        or (select count(*) from jsonb_array_elements(p_mail->'items'))<>(select count(distinct v->>'id') from jsonb_array_elements(p_mail->'items') v) then raise exception 'Invalid gift items.';end if;
    if (p_snapshot->>'meat')::bigint<(a.before_state->>'meat')::bigint+(p_mail->>'meat')::bigint then raise exception 'Gift Meat not secured.';end if;
    for x in select jsonb_build_object('id',key,'quantity',value) from jsonb_each_text(a.before_state->'items')
        union select jsonb_build_object('id',v->>'id','quantity','0') from jsonb_array_elements(p_mail->'items') v loop
        needed:=(x->>'quantity')::bigint-case when (x->>'id')::integer=a.wrapper_id then 1 else 0 end
            +coalesce((select sum((v->>'quantity')::bigint) from jsonb_array_elements(p_mail->'items') v where v->>'id'=x->>'id'),0);
        if coalesce((p_snapshot#>>array['items',x->>'id'])::bigint,0)<needed then raise exception 'Gift items not secured.';end if;
    end loop;
    update khub_bot.incoming_gifts set payload=p_mail,opened_at=clock_timestamp() where mail_id=g.mail_id;
    update khub_bot.gift_open_attempts set state='verified',mail_id=g.mail_id,after_state=p_snapshot,resolved_at=clock_timestamp(),
        evidence='Updated original KMail identity and acquired asset balances verified; original envelope and contents retained.' where id=a.id;
    if g.legacy_donation then
        if p_mail#>>'{command,type}'<>'donation' then raise exception 'Historical gifts remain donations.';end if;
        perform khub_bot.queue_closet('opened-legacy-gift:'||g.mail_id,'donation',g.mail_id,null,(p_mail->>'meat')::bigint,p_mail->'items');
    end if;
end; $$;
-- An operator can release ONLY a confirmed no-open attempt; this command never
-- opens anything. Missing mail or missing contents alone is not proof of failure.
create function public.bot_resolve_gift_not_opened(p_attempt uuid,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if length(btrim(coalesce(p_evidence,'')))<20 then raise exception 'Record verified unopened KMail and unchanged inventory evidence.';end if;
    update khub_bot.gift_open_attempts set state='not_opened',evidence=p_evidence,resolved_at=clock_timestamp() where id=p_attempt and state='opening';
    if not found then raise exception 'Only an unresolved gift open can be released.';end if;
end; $$;
-- Stop generic wrapper sweeps: a stack can contain another player's auction
-- deposit. Opened donation CONTENTS use the existing audited closet queue instead.
update khub_bot.closet_transfers set state='cancelled',evidence='Incoming auction gifts enabled; unopened wrapper sweep retired. Contents will be identified by original KMail.'
    where source='gift_package' and state='pending' and attempt is null;
create or replace function public.bot_queue_gift_packages(p_inventory jsonb,p_review_items jsonb) returns void
language plpgsql security definer set search_path='' as $$begin return;end;$$;
alter function public.bot_liabilities() rename to liabilities_before_incoming_gifts;
alter function public.liabilities_before_incoming_gifts() set schema khub_bot;
revoke all on function khub_bot.liabilities_before_incoming_gifts() from public,anon,authenticated,service_role;
create function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
with base as (select khub_bot.liabilities_before_incoming_gifts() b), unposted as (
    select g.payload p from khub_bot.incoming_gifts g where payload is not null and not legacy_donation
        and not exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)
), assets as (
    select key::integer id,value::numeric n from base,jsonb_each_text(b->'items')
    union all select (x->>'id')::integer,(x->>'quantity')::numeric from unposted,jsonb_array_elements(p->'items') x
), totals as (select id,sum(n) n from assets group by id)
select jsonb_build_object('meat',((b->>'meat')::numeric+coalesce((select sum((p->>'meat')::numeric) from unposted),0))::text,
    'items',coalesce((select jsonb_object_agg(id,n::text) from totals),'{}')) from base;
$$;
-- Canonical normal-mail adapters must have a durable, verified gift proof.
alter function public.bot_ingest_mail(jsonb) rename to ingest_before_incoming_gifts;
alter function public.ingest_before_incoming_gifts(jsonb) set schema khub_bot;
revoke all on function khub_bot.ingest_before_incoming_gifts(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_mail(p_mail jsonb) returns text language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_mail->'raw' ? 'gift_original' and not exists(select 1 from khub_bot.incoming_gifts where mail_id=p_mail->>'id' and payload=p_mail and not legacy_donation) then raise exception 'Gift contents have not been verified.';end if;
    return khub_bot.ingest_before_incoming_gifts(p_mail);
end;$$;
-- An older worker cannot silently treat new auction packages as donations.
alter function public.bot_ingest_donation(jsonb) rename to donation_before_incoming_gifts;
alter function public.donation_before_incoming_gifts(jsonb) set schema khub_bot;
revoke all on function khub_bot.donation_before_incoming_gifts(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_donation(p_mail jsonb) returns text language plpgsql security definer set search_path='' as $$
begin
    if p_mail#>>'{raw,type}'='giftshop' then raise exception 'Upgrade the worker for incoming gift intake before proceeding.';end if;
    if p_mail->'raw' ? 'gift_original' and not exists(select 1 from khub_bot.incoming_gifts where mail_id=p_mail->>'id' and payload=p_mail and not legacy_donation) then raise exception 'Gift contents have not been verified.';end if;
    return khub_bot.donation_before_incoming_gifts(p_mail);
end;$$;
alter function public.bot_claim_delivery(integer) rename to claim_before_incoming_gifts;
alter function public.claim_before_incoming_gifts(integer) set schema khub_bot;
revoke all on function khub_bot.claim_before_incoming_gifts(integer) from public,anon,authenticated,service_role;
create function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin
    if p_message_version is distinct from 4 then raise exception 'Upgrade the worker for incoming gifts (message version 4).';end if;
    if exists(select 1 from khub_bot.gift_open_attempts where state='opening') then raise exception 'Unresolved gift open; verify original KMail before dispatch.';end if;
    return khub_bot.claim_before_incoming_gifts(3);
end;$$;
alter function public.bot_inspect() rename to inspect_before_incoming_gifts;
alter function public.inspect_before_incoming_gifts() set schema khub_bot;
revoke all on function khub_bot.inspect_before_incoming_gifts() from public,anon,authenticated,service_role;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
select khub_bot.inspect_before_incoming_gifts()||jsonb_build_object('incomingGiftsVersion',1,
    'giftOpenAttention',coalesce((select jsonb_agg(to_jsonb(a)) from khub_bot.gift_open_attempts a where state='opening'),'[]'));
$$;
revoke all on function public.bot_gift_intake_state(),public.bot_register_gift_mail(jsonb),public.bot_claim_gift_open(jsonb),
    public.bot_finish_gift_open(uuid,jsonb,jsonb),public.bot_resolve_gift_not_opened(uuid,text),public.bot_liabilities(),
    public.bot_ingest_mail(jsonb),public.bot_ingest_donation(jsonb),public.bot_claim_delivery(integer),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_gift_intake_state(),public.bot_register_gift_mail(jsonb),public.bot_claim_gift_open(jsonb),
    public.bot_finish_gift_open(uuid,jsonb,jsonb),public.bot_resolve_gift_not_opened(uuid,text),public.bot_liabilities(),
    public.bot_ingest_mail(jsonb),public.bot_ingest_donation(jsonb),public.bot_claim_delivery(integer),public.bot_inspect() to service_role;
do $$declare definition text;begin
    definition:=pg_get_functiondef('khub_bot.ingest_before_incoming_gifts(jsonb)'::regprocedure);
    if strpos(definition,'Send a normal KMail to kHub (#3888760).')=0 then raise exception 'Unexpected bid-help instruction template.';end if;
    execute replace(definition,'Send a normal KMail to kHub (#3888760).','Send KMail to kHub (#3888760), or a gift package if you are in Hardcore/Ronin. For packages, put the command in the outside message.');
end;$$;
notify pgrst,'reload schema';
commit;
