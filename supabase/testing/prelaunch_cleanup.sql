-- MANUAL PRE-LAUNCH CLEANUP, not an application migration.
-- Stop ALL Oracle/local bot workers first. Take a database backup.
-- Run the whole file as postgres in Supabase SQL Editor.
-- First run previews only. Review the result sets, then change apply_changes
-- to true and rerun. Never use this as a post-launch maintenance script.
-- Keeps only the verified teres Minor login, catalog/settings, receipts, delivery IDs,
-- sent-message evidence and closet history. Auction snapshots remain private
-- for old delivery lookups. No messages/assets are sent and no IDs are reset.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888760);
lock table public.auctions,public.bids,public.profiles,auth.users,
    khub_bot.bug_reports,khub_bot.deliveries,khub_bot.closet_transfers,
    khub_bot.account_jobs in share row exclusive mode;

create temporary table cleanup_options(scope text check(scope in ('all_prelaunch','seeded_only')),apply_changes boolean not null) on commit drop;
-- all_prelaunch: ALL current auctions and ALL Auth accounts except verified teres Minor (#3552305).
-- seeded_only: explicitly registered seed accounts and auctions involving them.
-- BOTH modes clear the entire administrator inbox, including trade reports.
insert into cleanup_options values ('all_prelaunch',true);

create temporary table cleanup_protected(id uuid primary key) on commit drop;
insert into cleanup_protected
    select u.id from auth.users u join public.profiles p on p.id=u.id
    where p.kol_player_id=3552305 and p.kol_verified_at is not null;
do $$ begin
    if (select count(*) from cleanup_protected)<>1 then
        raise exception 'Expected exactly one verified teres Minor account (#3552305). Nothing was changed.';
    end if;
end; $$;
create temporary table cleanup_seed_users(id uuid primary key) on commit drop;
insert into cleanup_seed_users select id from auth.users where raw_app_meta_data->>'khub_test_seed'='v1';
do $$ begin
    if to_regclass('khub_bot.test_accounts') is not null then
        execute 'insert into cleanup_seed_users select user_id from khub_bot.test_accounts on conflict do nothing';
    end if;
end; $$;
create temporary table cleanup_users on commit drop as
    select u.id,p.khub_username as username,p.kol_player_id,p.kol_player_name
    from auth.users u left join public.profiles p on p.id=u.id
    where not exists(select 1 from cleanup_protected k where k.id=u.id)
        and ((select scope='all_prelaunch' from cleanup_options)
             or exists(select 1 from cleanup_seed_users s where s.id=u.id));
create temporary table cleanup_jobs on commit drop as
    select j.mail_id from khub_bot.account_jobs j
    where j.user_id in (select id from cleanup_users)
        or ((select scope='all_prelaunch' from cleanup_options)
            and j.user_id not in (select id from cleanup_protected)
            and j.kol_player_id<>3552305
            and not exists(select 1 from public.profiles p join cleanup_protected k on k.id=p.id
                where p.kol_player_id=j.kol_player_id));
create temporary table cleanup_auctions(id uuid primary key) on commit drop;
insert into cleanup_auctions select a.id from public.auctions a
    where (select scope='all_prelaunch' from cleanup_options)
       or a.seller_id in (select id from cleanup_users)
       or a.winner_id in (select id from cleanup_users)
       or a.highest_bidder_id in (select id from cleanup_users)
       or exists(select 1 from public.bids b where b.auction_id=a.id and b.bidder_id in (select id from cleanup_users));
do $$ begin
    if to_regclass('khub_bot.test_auction_fixtures') is not null then
        execute 'insert into cleanup_auctions select auction_id from khub_bot.test_auction_fixtures on conflict do nothing';
    end if;
end; $$;
create temporary table cleanup_reports on commit drop as select id from khub_bot.bug_reports;
create temporary table cleanup_receipts on commit drop as
    select r.mail_id from khub_bot.receipts r where r.sender_id in (select kol_player_id from cleanup_users)
        or r.mail_id in (select mail_id from cleanup_jobs)
        or exists(select 1 from public.auctions a join cleanup_auctions t on t.id=a.id
            where r.payload#>>'{command,auction_id}' in (a.id::text,a.auction_number::text));
create temporary table cleanup_deliveries(id uuid primary key) on commit drop;
insert into cleanup_deliveries select d.id from khub_bot.deliveries d
    where d.auction_id in (select id from cleanup_auctions)
       or d.receipt_id in (select mail_id from cleanup_receipts)
       or d.recipient_id in (select kol_player_id from cleanup_users)
       or d.id in (select delivery_id from khub_bot.bug_report_deliveries where report_id in (select id from cleanup_reports))
       or d.id in (select delivery_id from khub_bot.rating_notifications where auction_id in (select id from cleanup_auctions))
       or d.id in (select withdrawal_delivery_id from khub_bot.trade_reports where report_id in (select id from cleanup_reports));
-- Also cancel an unattempted manual-review notice for a selected delivery.
insert into cleanup_deliveries select d.id from khub_bot.deliveries d
    where exists(select 1 from cleanup_deliveries t where d.dedupe_key='manual-review:'||t.id)
    on conflict do nothing;
create temporary table cleanup_closet on commit drop as
    select id from khub_bot.closet_transfers where auction_id in (select id from cleanup_auctions)
        or receipt_id in (select mail_id from cleanup_receipts);
create temporary table cleanup_bans on commit drop as
    select b.id from khub_bot.account_bans b where exists(select 1 from cleanup_users u
        where b.kol_player_id=u.kol_player_id or lower(btrim(b.username)) in (lower(u.username),lower(u.kol_player_name)))
        and not exists(select 1 from public.profiles p join cleanup_protected k on k.id=p.id
            where b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in (lower(p.khub_username),lower(p.kol_player_name)));

create temporary table cleanup_blockers(kind text,reference text,state text,reason text) on commit drop;
insert into cleanup_blockers select 'delivery','D-'||reference_number,state,'Reconcile uncertain transfers using actual sent-copy evidence.'
    from khub_bot.deliveries where state in ('sending','unknown');
insert into cleanup_blockers select 'delivery','D-'||d.reference_number,d.state,'Complete/refund this asset delivery before cleanup.'
    from khub_bot.deliveries d join cleanup_deliveries t on t.id=d.id
    where d.state<>'sent' and (d.meat>0 or d.quantity>0);
insert into cleanup_blockers select 'closet','C-'||reference_number,state,'Resolve the pending/uncertain asset move first.'
    from khub_bot.closet_transfers where state in ('moving','unknown') or (state not in ('moved','cancelled') and id in (select id from cleanup_closet));
insert into cleanup_blockers select 'auction',a.auction_number::text,a.status,'Escrow items or settlement obligations are still outstanding.'
    from public.auctions a join cleanup_auctions t on t.id=a.id where a.escrow_mode
        and (a.status in ('active','settling') or (a.item_escrowed_at is not null and a.settled_at is null));
insert into cleanup_blockers select 'receipt',r.receipt_id,'review','A legacy donation refund still needs review.'
    from khub_bot.mail_policy_reviews r where not r.refund_queued and r.receipt_id in (select mail_id from cleanup_receipts);

-- One result table for Supabase SQL Editor. Keep mode and blockers first so
-- they are visible without switching result sets. Lists are included as JSON.
-- No passwords, emails or request bodies are printed.
select case when apply_changes then 'APPLY' else 'PREVIEW ONLY' end as mode,
    (select count(*) from cleanup_blockers) as blockers,
    (select p.khub_username||' (#'||p.kol_player_id||')'
        from public.profiles p join cleanup_protected k on k.id=p.id) as account_to_keep,
    (select count(*) from cleanup_users) as accounts_to_remove,
    (select count(*) from cleanup_auctions) as auctions_to_remove,
    (select count(*) from cleanup_reports) as inbox_messages_to_remove,
    coalesce((select jsonb_agg(to_jsonb(b) order by b.kind,b.reference) from cleanup_blockers b),'[]'::jsonb) as blocker_details,
    coalesce((select jsonb_agg(jsonb_build_object('id',id,'username',username,'kol_player_id',kol_player_id)
        order by username nulls last) from cleanup_users),'[]'::jsonb) as account_details,
    coalesce((select jsonb_agg(jsonb_build_object('auction_number',a.auction_number,'item',a.item,
        'status',a.status,'escrow_mode',a.escrow_mode) order by a.auction_number)
        from public.auctions a join cleanup_auctions t on t.id=a.id),'[]'::jsonb) as auction_details
from cleanup_options;

do $$ begin
    if not (select apply_changes from cleanup_options) then
        raise notice 'PREVIEW ONLY. No persistent data changed. Review the scope and blockers before enabling apply_changes.';
        return;
    end if;
    if exists(select 1 from cleanup_blockers) then
        raise exception 'Cleanup blocked by outstanding assets or uncertain transfers. Nothing was changed. Run preview and resolve its blockers first.';
    end if;

    -- Preserve auction context for historical D-/C-reference lookups after the
    -- public test listing is gone. This is private audit data, not live history.
    create table if not exists khub_bot.prelaunch_auction_archive (
        auction_id uuid primary key,auction_data jsonb not null,archived_at timestamptz not null default clock_timestamp()
    );
    alter table khub_bot.prelaunch_auction_archive enable row level security;
    revoke all on khub_bot.prelaunch_auction_archive from public,anon,authenticated;
    grant all on khub_bot.prelaunch_auction_archive to service_role;
    insert into khub_bot.prelaunch_auction_archive(auction_id,auction_data)
        select a.id,to_jsonb(a) from public.auctions a join cleanup_auctions t on t.id=a.id on conflict do nothing;

    -- Cancel only zero-asset notices currently pending (unsent or reconciled
    -- as not sent). Uncertain sends are blocked above. Preserve
    -- financial rows, references, states and saved sent bodies for reconciliation.
    update khub_bot.deliveries set state='cancelled',evidence='Pre-launch cleanup: unsent test/inbox notice cancelled.'
        where id in (select id from cleanup_deliveries) and state='pending' and kind='notice' and meat=0 and quantity=0;
    update khub_bot.deliveries set message='Removed test account: unsent credential reply cancelled.',
        display_message='Removed test account: unsent credential reply cancelled.'
        where receipt_id in (select mail_id from cleanup_jobs) and dedupe_key like 'account-credentials:%' and state='cancelled';
    update khub_bot.account_jobs set state='done',temporary_password=null where mail_id in (select mail_id from cleanup_jobs);

    delete from khub_bot.trade_rating_reviews where report_id in (select id from cleanup_reports);
    delete from khub_bot.trade_rating_withdrawals where report_id in (select id from cleanup_reports);
    delete from khub_bot.trade_queries where report_id in (select id from cleanup_reports);
    delete from khub_bot.trade_reports where report_id in (select id from cleanup_reports);
    delete from khub_bot.support_tickets where report_id in (select id from cleanup_reports);
    delete from khub_bot.appeal_evidence where report_id in (select id from cleanup_reports);
    delete from khub_bot.account_failure_notices where report_id in (select id from cleanup_reports);
    delete from khub_bot.bug_report_activity where report_id in (select id from cleanup_reports);
    delete from khub_bot.support_category_activity where report_id in (select id from cleanup_reports);
    delete from khub_bot.bug_report_deliveries where report_id in (select id from cleanup_reports);
    delete from khub_bot.bug_reports where id in (select id from cleanup_reports);
    delete from khub_bot.rating_notifications where auction_id in (select id from cleanup_auctions)
        or actor_id in (select id from cleanup_users) or recipient_id in (select id from cleanup_users);
    delete from khub_bot.trade_feedback where auction_id in (select id from cleanup_auctions)
        or actor_id in (select id from cleanup_users) or recipient_id in (select id from cleanup_users);
    delete from khub_bot.auction_ban_reviews where auction_id in (select id from cleanup_auctions);
    update khub_bot.auction_ban_reviews set administrator_id=null where administrator_id in (select id from cleanup_users);
    update khub_bot.deliveries set auction_id=null where auction_id in (select id from cleanup_auctions);
    update khub_bot.closet_transfers set auction_id=null where auction_id in (select id from cleanup_auctions);
    if to_regclass('khub_bot.test_auction_fixtures') is not null then
        execute 'delete from khub_bot.test_auction_fixtures where auction_id in (select id from cleanup_auctions)';
    end if;
    delete from public.bids where auction_id in (select id from cleanup_auctions);
    delete from public.auctions where id in (select id from cleanup_auctions);
    delete from khub_bot.verifications where user_id in (select id from cleanup_users);
    delete from khub_bot.account_ban_activity where ban_id in (select id from cleanup_bans);
    update khub_bot.account_ban_activity set administrator_id=null where administrator_id in (select id from cleanup_users);
    delete from khub_bot.ban_publications where ban_id in (select id from cleanup_bans);
    delete from khub_bot.account_bans where id in (select id from cleanup_bans);
    if to_regclass('khub_bot.test_accounts') is not null then
        execute 'delete from khub_bot.test_accounts where user_id in (select id from cleanup_users)';
    end if;
    delete from khub_bot.administrators where user_id in (select id from cleanup_users);
    -- Native Auth foreign keys revoke sessions/identities; profiles cascade.
    -- Unexpected external references abort and roll back the entire cleanup.
    delete from auth.users where id in (select id from cleanup_users);
    raise notice 'Cleanup applied. Only teres Minor was protected; catalog, receipts and financial evidence were retained. No sequence was reset.';
end; $$;
commit;
