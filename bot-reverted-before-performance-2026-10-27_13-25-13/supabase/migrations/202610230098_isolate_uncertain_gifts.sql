-- Apply after 097 with the bot stopped, then install the matching worker.
-- Isolate uncertain intake; protect unidentified assets while unrelated work continues.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.gift_open_attempts drop constraint gift_open_attempts_state_check;
alter table khub_bot.gift_open_attempts add constraint gift_open_attempts_state_check check(state in ('opening','verified','not_opened','isolated'));
create table khub_bot.gift_mail_reviews (
    mail_id text primary key, raw jsonb not null, evidence text not null,
    created_at timestamptz not null default clock_timestamp(),resolved_at timestamptz,resolution text
);
create table khub_bot.gift_asset_protection (
    id boolean primary key default true check(id), safe_operating_meat bigint not null default 0 check(safe_operating_meat>=0),
    operating_reserve bigint not null default 0 check(operating_reserve>=0),
    held jsonb not null default '{"meat":"0","items":{}}', updated_at timestamptz not null default clock_timestamp()
);
insert into khub_bot.gift_asset_protection(id) values(true);
create table khub_bot.gift_safe_wrapping (
    delivery_id uuid not null references khub_bot.deliveries(id),attempt uuid not null,
    cost bigint not null check(cost=50),released boolean not null default false,created_at timestamptz not null default clock_timestamp(),
    primary key(delivery_id,attempt)
);
alter table khub_bot.gift_mail_reviews enable row level security;
alter table khub_bot.gift_asset_protection enable row level security;
alter table khub_bot.gift_safe_wrapping enable row level security;
revoke all on khub_bot.gift_mail_reviews,khub_bot.gift_asset_protection,khub_bot.gift_safe_wrapping from public,anon,authenticated;
create function khub_bot.gift_review_active() returns boolean language sql stable set search_path='' as $$
select exists(select 1 from khub_bot.gift_open_attempts where state='isolated')
    or exists(select 1 from khub_bot.gift_mail_reviews where resolved_at is null);
$$;
-- Add quarantined surplus to the same protection used by payouts and closet moves.
alter function public.bot_liabilities() rename to liabilities_before_gift_isolation;
alter function public.liabilities_before_gift_isolation() set schema khub_bot;
revoke all on function khub_bot.liabilities_before_gift_isolation() from public,anon,authenticated,service_role;
create function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
with b as (select khub_bot.liabilities_before_gift_isolation() v), h as(select held v from khub_bot.gift_asset_protection where id),
assets as(select key,value::numeric n from b,jsonb_each_text(b.v->'items') union all select key,value::numeric from h,jsonb_each_text(h.v->'items')),
totals as(select key,sum(n) n from assets group by key)
select jsonb_build_object('meat',((b.v->>'meat')::numeric+(h.v->>'meat')::numeric)::text,
    'items',coalesce((select jsonb_object_agg(key,n::text) from totals),'{}')) from b,h;
$$;
create function public.bot_refresh_gift_protection(p_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b jsonb; h jsonb; quota bigint; operating_reserve bigint; x record; held_items jsonb:='{}';n numeric; closet_meat numeric;
begin
    perform pg_advisory_xact_lock(3888760);
    if not khub_bot.gift_review_active() then
        update khub_bot.gift_asset_protection set held='{"meat":"0","items":{}}',safe_operating_meat=0,operating_reserve=0,updated_at=clock_timestamp() where id;
        return '{"meat":"0","items":{}}';
    end if;
    b:=khub_bot.liabilities_before_gift_isolation();
    select safe_operating_meat,p.operating_reserve into quota,operating_reserve from khub_bot.gift_asset_protection p where id;
    operating_reserve:=coalesce((p_snapshot->>'reserve')::bigint,operating_reserve);
    select coalesce(sum(meat),0) into closet_meat from khub_bot.closet_transfers where state in ('pending','moving','unknown');
    for x in select key,value from jsonb_each_text(p_snapshot->'items') loop
        n:=greatest(0,x.value::numeric-coalesce((b#>>array['items',x.key])::numeric,0)
            -coalesce((select sum(quantity) from khub_bot.closet_transfers where item_id::text=x.key and state in ('pending','moving','unknown')),0));
        if n>0 then held_items:=held_items||jsonb_build_object(x.key,n::text);end if;
    end loop;
    h:=jsonb_build_object('meat',greatest(0,(p_snapshot->>'meat')::numeric-(b->>'meat')::numeric-closet_meat-quota-operating_reserve)::text,'items',held_items);
    update khub_bot.gift_asset_protection p set held=h,operating_reserve=coalesce((p_snapshot->>'reserve')::bigint,p.operating_reserve),updated_at=clock_timestamp() where id;
    return h;
end;$$;
create or replace function public.bot_claim_gift_open(p_snapshot jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a khub_bot.gift_open_attempts%rowtype; g khub_bot.incoming_gifts%rowtype; b jsonb; pending_meat numeric; owned bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from khub_bot.gift_open_attempts where state='opening') then raise exception 'An opening claim is active; isolate it before claiming another.';end if;
    if exists(select 1 from khub_bot.closet_transfers where state in ('moving','unknown')) then return null;end if;
    b:=khub_bot.liabilities_before_gift_isolation();
    select * into g from khub_bot.incoming_gifts m where payload is null
        and not exists(select 1 from khub_bot.gift_mail_reviews r where r.mail_id=m.mail_id and r.resolved_at is null)
        and coalesce((p_snapshot#>>array['items',wrapper_id::text])::numeric,0)>coalesce((b#>>array['items',wrapper_id::text])::numeric,0)
        and not exists(select 1 from khub_bot.closet_transfers c where c.item_id=m.wrapper_id and c.state in ('pending','moving','unknown'))
        order by (envelope->>'azunixtime')::bigint,mail_id::bigint limit 1;
    if not found then return null;end if;
    select coalesce(sum((v->>'meat')::numeric),0) into pending_meat from jsonb_array_elements(coalesce(p_snapshot->'observed_normal','[]')) v
        where not exists(select 1 from khub_bot.receipts r where r.mail_id=v->>'id');
    owned:=greatest(0,(p_snapshot->>'meat')::numeric-(b->>'meat')::numeric-pending_meat
        -coalesce((select sum(meat) from khub_bot.closet_transfers where state in ('pending','moving','unknown')),0)
        -coalesce((p_snapshot->>'reserve')::bigint,0));
    insert into khub_bot.gift_open_attempts(wrapper_id,before_state)
        values(g.wrapper_id,p_snapshot||jsonb_build_object('safe_operating_meat',owned,'requested_mail_id',g.mail_id)) returning * into a;
    return to_jsonb(a);
end;$$;
create function public.bot_isolate_gift_open(p_attempt uuid,p_evidence text,p_mail_ids text[]) returns void language plpgsql security definer set search_path='' as $$
declare a khub_bot.gift_open_attempts%rowtype; active boolean; mid text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from khub_bot.gift_open_attempts where id=p_attempt for update;

    if a.id is null or a.state not in ('opening','isolated','verified') or length(p_evidence)<12 then raise exception 'Invalid isolation claim.';end if;
    active:=khub_bot.gift_review_active();
    update khub_bot.gift_asset_protection set safe_operating_meat=case when active then least(safe_operating_meat,(a.before_state->>'safe_operating_meat')::bigint)
        else coalesce((a.before_state->>'safe_operating_meat')::bigint,0) end,
        operating_reserve=case when active then operating_reserve else coalesce((a.before_state->>'reserve')::bigint,0) end where id;
    update khub_bot.gift_open_attempts set state='isolated',evidence=p_evidence where id=a.id;
    foreach mid in array p_mail_ids loop
        insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence)
            select mail_id,envelope,p_evidence from khub_bot.incoming_gifts where mail_id=mid on conflict(mail_id) do nothing;
    end loop;
end;$$;
create function public.bot_review_gift_mail(p_raw jsonb,p_evidence text) returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if p_raw->>'id' !~ '^[1-9][0-9]*$' or p_raw->>'type'<>'giftshop' or length(p_evidence)<12 then raise exception 'Invalid review mail.';end if;
    -- Without a trustworthy pre-open baseline, no spare income is spendable.
    if not khub_bot.gift_review_active() then update khub_bot.gift_asset_protection set safe_operating_meat=0 where id;end if;
    insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence) values(p_raw->>'id',p_raw,p_evidence) on conflict(mail_id) do update set raw=excluded.raw,evidence=excluded.evidence;
end;$$;
-- Only pre-uncertainty operating Meat may pay wrapping; unknown surplus cannot.
create function public.bot_authorize_safe_gift_wrapping(p_id uuid,p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if not khub_bot.gift_review_active() then return;end if;
    if exists(select 1 from khub_bot.gift_safe_wrapping where delivery_id=p_id and attempt=p_attempt and not released) then return;end if;
    if not exists(select 1 from khub_bot.deliveries where id=p_id and attempt=p_attempt and state='sending') then raise exception 'Invalid wrapping claim.';end if;
    update khub_bot.gift_asset_protection set safe_operating_meat=safe_operating_meat-50 where id and safe_operating_meat>=50;
    if not found then raise exception 'No verified kHub operating funds for wrapping; unknown package contents remain protected.';end if;
    insert into khub_bot.gift_safe_wrapping(delivery_id,attempt,cost,released) values(p_id,p_attempt,50,false)
        on conflict(delivery_id,attempt) do update set released=false;
end;$$;
create function public.bot_release_safe_gift_wrapping(p_id uuid,p_attempt uuid) returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    update khub_bot.gift_safe_wrapping set released=true where delivery_id=p_id and attempt=p_attempt and not released;
    if found then update khub_bot.gift_asset_protection set safe_operating_meat=safe_operating_meat+50 where id;end if;
end;$$;
-- Operator recovery records evidence; these functions never send or open assets.
create function public.bot_resolve_gift_review(p_mail_id text,p_evidence text) returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if length(btrim(coalesce(p_evidence,'')))<20 then raise exception 'Record verified original KMail and reconciled asset evidence.';end if;
    update khub_bot.gift_mail_reviews set resolved_at=clock_timestamp(),resolution=p_evidence where mail_id=p_mail_id and resolved_at is null;
    if not found then raise exception 'No unresolved gift review found.';end if;
end;$$;
create function public.bot_resolve_gift_isolation(p_attempt uuid,p_evidence text) returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if length(btrim(coalesce(p_evidence,'')))<20 then raise exception 'Record verified original KMail and reconciled asset evidence.';end if;
    update khub_bot.gift_open_attempts set state='verified',resolved_at=clock_timestamp(),evidence=p_evidence where id=p_attempt and state='isolated';
    if not found then raise exception 'No isolated gift attempt found.';end if;
end;$$;
-- Keep the old verified-content checks. During overlapping delayed openings,
-- other wrappers may also disappear; only verified contents are credited once.
create table khub_bot.gift_verified_contents (
    mail_id text primary key references khub_bot.incoming_gifts(mail_id),observed_attempt uuid references khub_bot.gift_open_attempts(id),
    snapshot jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.gift_verified_contents enable row level security;
revoke all on khub_bot.gift_verified_contents from public,anon,authenticated;
do $$declare d text; start_at integer;end_at integer;begin
    d:=pg_get_functiondef('public.bot_finish_gift_open(uuid,jsonb,jsonb)'::regprocedure);
    d:=replace(d,$old$a.state<>'opening'$old$,$new$a.state not in ('opening','isolated','verified')$new$);
    start_at:=strpos(d,$anchor$    if (p_snapshot->>'meat')::bigint<$anchor$);
    end_at:=strpos(d,'    update khub_bot.incoming_gifts set payload=');
    if start_at=0 or end_at=0 then raise exception 'Unexpected gift verification function.';end if;
    d:=substring(d from 1 for start_at-1)||$check$
    -- Secure each genuine original KMail's contents against all existing books.
    -- The protection ledger reserves the residual unknown assets separately.
    declare b jsonb:=khub_bot.liabilities_before_gift_isolation(); normal_meat numeric;
    begin
        select coalesce(sum((v->>'meat')::numeric),0) into normal_meat from jsonb_array_elements(coalesce(p_snapshot->'observed_normal','[]')) v
            where not exists(select 1 from khub_bot.receipts r where r.mail_id=v->>'id');
        if (p_snapshot->>'meat')::numeric<(b->>'meat')::numeric+(p_mail->>'meat')::numeric+normal_meat
            +coalesce((select sum(meat) from khub_bot.closet_transfers where state in ('pending','moving','unknown')),0) then raise exception 'Gift Meat not secured.';end if;
        for x in select value from jsonb_array_elements(p_mail->'items') loop
            needed:=(x->>'quantity')::bigint+coalesce((b#>>array['items',x->>'id'])::bigint,0)
                +coalesce((select sum(quantity) from khub_bot.closet_transfers where item_id=(x->>'id')::integer and state in ('pending','moving','unknown')),0)
                +coalesce((select sum((i->>'quantity')::bigint) from jsonb_array_elements(coalesce(p_snapshot->'observed_normal','[]')) v,
                    jsonb_array_elements(coalesce(v->'items','[]')) i where i->>'id'=x->>'id'
                    and not exists(select 1 from khub_bot.receipts r where r.mail_id=v->>'id')),0);
            if coalesce((p_snapshot#>>array['items',x->>'id'])::bigint,0)<needed then raise exception 'Gift items not secured.';end if;
        end loop;
    end;
$check$||substring(d from end_at);
    d:=replace(d,$old$set state='verified',mail_id=g.mail_id$old$,$new$set state=case when state='isolated' then 'isolated' else 'verified' end,mail_id=coalesce(mail_id,g.mail_id)$new$);
    d:=replace(d,$anchor$    if g.legacy_donation then$anchor$,$new$
    insert into khub_bot.gift_verified_contents(mail_id,observed_attempt,snapshot) values(g.mail_id,a.id,p_snapshot);
    update khub_bot.gift_mail_reviews set resolved_at=clock_timestamp(),resolution='Original KMail contents verified and secured.' where mail_id=g.mail_id and resolved_at is null;
    if g.legacy_donation then$new$);
    execute d;
    d:=pg_get_functiondef('public.bot_resolve_gift_not_opened(uuid,text)'::regprocedure);
    execute replace(d,$old$state='opening'$old$,$new$state in ('opening','isolated')$new$);
end;$$;
alter function public.bot_gift_intake_state() rename to gift_state_before_isolation;
alter function public.gift_state_before_isolation() set schema khub_bot;
revoke all on function khub_bot.gift_state_before_isolation() from public,anon,authenticated,service_role;
create function public.bot_gift_intake_state() returns jsonb language sql security definer set search_path='' as $$
select khub_bot.gift_state_before_isolation()||jsonb_build_object('isolation_version',1,
    'reviews',coalesce((select jsonb_agg(mail_id) from khub_bot.gift_mail_reviews where resolved_at is null),'[]'),
    'review_mail',coalesce((select jsonb_agg(to_jsonb(r)) from khub_bot.gift_mail_reviews r where resolved_at is null),'[]'),
    'isolated',coalesce((select jsonb_agg(to_jsonb(a)) from khub_bot.gift_open_attempts a where state='isolated'),'[]'));
$$;
alter function public.bot_claim_delivery(integer) rename to claim_before_gift_isolation;
alter function public.claim_before_gift_isolation(integer) set schema khub_bot;
revoke all on function khub_bot.claim_before_gift_isolation(integer) from public,anon,authenticated,service_role;
create function public.bot_claim_delivery(p_message_version integer) returns jsonb language plpgsql security definer set search_path='' as $$
begin
    if p_message_version is distinct from 5 then raise exception 'Upgrade the worker for isolated gift intake (message version 5).';end if;
    return khub_bot.claim_before_gift_isolation(4);
end;$$;
alter function public.bot_inspect() rename to inspect_before_gift_isolation;
alter function public.inspect_before_gift_isolation() set schema khub_bot;
revoke all on function khub_bot.inspect_before_gift_isolation() from public,anon,authenticated,service_role;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
select khub_bot.inspect_before_gift_isolation()||jsonb_build_object('incomingGiftsVersion',2,'giftIsolationVersion',1,
    'giftIsolatedAttention',coalesce((select jsonb_agg(to_jsonb(a)) from khub_bot.gift_open_attempts a where state='isolated'),'[]'),
    'giftMailReviews',coalesce((select jsonb_agg(jsonb_build_object('mail_id',mail_id,'evidence',evidence)) from khub_bot.gift_mail_reviews where resolved_at is null),'[]'),
    'giftAssetProtection',(select to_jsonb(p) from khub_bot.gift_asset_protection p where id));
$$;
revoke all on function khub_bot.gift_review_active() from public,anon,authenticated,service_role;
revoke all on function public.bot_resolve_gift_review(text,text),public.bot_resolve_gift_isolation(uuid,text),public.bot_refresh_gift_protection(jsonb),public.bot_isolate_gift_open(uuid,text,text[]),public.bot_review_gift_mail(jsonb,text),
    public.bot_authorize_safe_gift_wrapping(uuid,uuid),public.bot_release_safe_gift_wrapping(uuid,uuid),public.bot_liabilities(),public.bot_gift_intake_state(),public.bot_claim_delivery(integer),public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_resolve_gift_review(text,text),public.bot_resolve_gift_isolation(uuid,text),public.bot_refresh_gift_protection(jsonb),public.bot_isolate_gift_open(uuid,text,text[]),public.bot_review_gift_mail(jsonb,text),
    public.bot_authorize_safe_gift_wrapping(uuid,uuid),public.bot_release_safe_gift_wrapping(uuid,uuid),public.bot_liabilities(),public.bot_gift_intake_state(),public.bot_claim_delivery(integer),public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
