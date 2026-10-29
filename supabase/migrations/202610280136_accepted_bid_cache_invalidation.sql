-- Accepted website AND bot bids share public.bids. Queue a signed, after-commit
-- cache notification; never make a network request on the bidding path.
-- Configure the destination only after deploying the Cloudflare handler.
begin;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table khub_bot.public_cache_revision (
    id boolean primary key default true check(id),
    revision bigint not null default 0 check(revision>=0),
    last_request_id bigint,
    last_queued_revision bigint,
    enqueue_failures bigint not null default 0,
    last_error_code text
);
insert into khub_bot.public_cache_revision(id) values(true);
create table khub_bot.public_cache_webhook_config (
    id boolean primary key default true check(id),
    endpoint text not null check(endpoint ~ '^https://[^/?#@]+/api/public-auctions/invalidate$'),
    signing_secret text not null check(signing_secret ~ '^[a-f0-9]{64}$')
);
alter table khub_bot.public_cache_revision enable row level security;
alter table khub_bot.public_cache_webhook_config enable row level security;
revoke all on khub_bot.public_cache_revision,khub_bot.public_cache_webhook_config from public,anon,authenticated,service_role;

-- Owner-only helper also permits a safe retry of the latest notification. No
-- bidder IDs, auction IDs, amounts, account details or signing keys enter pg_net.
create function khub_bot.send_public_cache_invalidation() returns void
language plpgsql security definer set search_path='' as $$
declare cfg khub_bot.public_cache_webhook_config%rowtype; rev bigint;
    crypto_schema text; signature text; request_id bigint;
begin
    select * into cfg from khub_bot.public_cache_webhook_config where id;
    if not found then return; end if;
    select revision into rev from khub_bot.public_cache_revision where id;
    begin
        select n.nspname into crypto_schema from pg_extension e join pg_namespace n on n.oid=e.extnamespace
            where e.extname='pgcrypto';
        execute format('select encode(%I.hmac($1,$2,''sha256''),''hex'')',crypto_schema)
            into signature using 'khub-public-auctions:v1:'||rev::text,cfg.signing_secret;
        execute 'select net.http_post(url:=$1,body:=$2,headers:=$3,timeout_milliseconds:=3000)'
            into request_id using cfg.endpoint,
                jsonb_build_object('revision',rev::text,'signature',signature),
                jsonb_build_object('Content-Type','application/json');
        update khub_bot.public_cache_revision set last_request_id=request_id,last_queued_revision=rev,last_error_code=null where id;
    exception when others then
        -- Even a missing pg_net extension or enqueue failure must not reject a
        -- valid bid, refund or ledger transaction. Keep a credential-free counter.
        update khub_bot.public_cache_revision set enqueue_failures=enqueue_failures+1,last_error_code=sqlstate where id;
    end;
end;$$;

create function khub_bot.invalidate_public_cache_after_bid() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    update khub_bot.public_cache_revision set revision=revision+1 where id;
    perform khub_bot.send_public_cache_invalidation();
    return null;
end;$$;
create trigger bids_invalidate_public_cache after insert on public.bids
    for each row execute function khub_bot.invalidate_public_cache_after_bid();
revoke all on function khub_bot.send_public_cache_invalidation(),khub_bot.invalidate_public_cache_after_bid()
    from public,anon,authenticated,service_role;

commit;
