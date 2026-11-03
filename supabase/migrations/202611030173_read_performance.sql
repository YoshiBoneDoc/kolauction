-- Prerequisites: all migrations through 172. Apply before deploying matching runtimes.
-- Backfill briefly blocks bid inserts; use a quiet period. No financial rules change.
begin;
set local lock_timeout='2s';
lock table public.bids in share row exclusive mode;
create table khub_bot.auction_bidder_labels (
 auction_id uuid not null references public.auctions(id) on delete cascade,
 bidder_id uuid not null,
 ordinal bigint not null,
 primary key(auction_id,bidder_id), unique(auction_id,ordinal)
);
revoke all on khub_bot.auction_bidder_labels from public,anon,authenticated,service_role;
insert into khub_bot.auction_bidder_labels
 select auction_id,bidder_id,row_number() over(partition by auction_id order by min(created_at),bidder_id)
 from public.bids group by auction_id,bidder_id;
create function khub_bot.assign_bidder_label() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Same auction row serialization used by bid writers; no global financial lock added.
 perform 1 from public.auctions where id=new.auction_id for update;
 insert into khub_bot.auction_bidder_labels
 select new.auction_id,new.bidder_id,coalesce(max(ordinal),0)+1
 from khub_bot.auction_bidder_labels where auction_id=new.auction_id
 on conflict(auction_id,bidder_id) do nothing;
 return new;
end;$$;
revoke all on function khub_bot.assign_bidder_label() from public,anon,authenticated,service_role;
create trigger persist_bidder_label before insert on public.bids for each row execute function khub_bot.assign_bidder_label();
-- Replace only the existing labels CTE, preserving every reader's visibility rules.
do $$declare f record; d text; patched text;
begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','khub_bot') and p.prokind='f' and p.prosrc like '%labels as materialized (%' and p.proname<>'read_auction_card_context' loop
 d:=pg_get_functiondef(f.oid);
 patched:=regexp_replace(d,'labels as materialized \(.*?\n[ \t]*\)',
 'labels as not materialized (select auction_id,bidder_id,''Bidder ''||ordinal::text as label from khub_bot.auction_bidder_labels)', 's');
 if patched=d then raise exception 'Unrecognized labels CTE in %',f.oid::regprocedure; end if;
 execute patched;
 end loop;
end;$$;
-- Keep complex Buy/closed-card behavior intact; active Sell cards need only identity context.
create or replace function public.read_auction_card_context(p_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare viewer uuid:=auth.uid(); admin boolean:=khub_bot.is_administrator(viewer);
 names boolean:=khub_bot.can_view_usernames();
begin
 if viewer is null then raise exception 'Sign in to read your auction context.' using errcode='42501'; end if;
 if p_ids is null or cardinality(p_ids)>24 then raise exception 'Choose at most 24 auctions.'; end if;
 return (select jsonb_build_object('privacy_version',1,'server_time',statement_timestamp(),
 'rows',coalesce(jsonb_agg(case when a.status='active' and a.auction_kind='sell' then
 jsonb_build_object('id',a.id,'seller_id',a.seller_id,'current_bid',a.current_bid,
 'usernames_visible',names or admin,
 'seller_username',case when names or admin then coalesce(s.khub_username,a.seller_username) else 'Seller' end,
 'highest_bidder_id',case when admin or a.highest_bidder_id=viewer then a.highest_bidder_id end,
 'highest_bidder_username',case when a.highest_bidder_id is null then null when admin then coalesce(b.khub_username,a.highest_bidder_username)
 when a.highest_bidder_id=viewer then 'You' else coalesce('Bidder '||h.ordinal::text,'Anonymous bidder') end,
 'viewer_is_highest_bidder',case when a.highest_bidder_id is null then null else a.highest_bidder_id=viewer end,
 'bidding_restricted',khub_bot.profile_is_restricted(a.seller_id),'escrow_timing_review',a.escrow_timing_review)
 else khub_bot.public_auction(a,0,'Bidder '||h.ordinal::text,'Bidder '||w.ordinal::text)-'bid_count' end),'[]'::jsonb))
 from khub_bot.visible_auctions() a
 left join public.profiles s on s.id=a.seller_id left join public.profiles b on b.id=a.highest_bidder_id
 left join khub_bot.auction_bidder_labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
 left join khub_bot.auction_bidder_labels w on w.auction_id=a.id and w.bidder_id=a.winner_id
 where a.id=any(p_ids) and a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a));
end;$$;
-- Visitors never rebuild discovery. Existing bot maintenance retries every minute.
create or replace function public.read_public_home_auctions() returns jsonb
language sql stable security definer set search_path='' as $$ select public.read_home_auctions(); $$;
do $$declare d text;begin
 d:=pg_get_functiondef('public.read_public_auction_page(text,uuid,text,text,text,integer,text,text,numeric,numeric,text,text)'::regprocedure);
 execute replace(d,'perform khub_bot.refresh_public_discovery();','');
end;$$;
create or replace function public.khub_record_site_activity(p_visitor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if p_visitor_id is null then raise exception 'Visitor ID required'; end if;
 insert into public.site_activity(visitor_id,user_id,last_seen) values(p_visitor_id,auth.uid(),now())
 on conflict(visitor_id) do update set user_id=excluded.user_id,last_seen=excluded.last_seen;
end;$$;
create or replace function public.bot_refresh_public_discovery() returns void
language plpgsql security definer set search_path='' as $$
begin
 perform khub_bot.refresh_public_discovery();
 delete from public.site_activity where last_seen<now()-interval '5 minutes';
end;$$;
do $$declare d text;begin
 d:=pg_get_functiondef('public.bot_worker_status()'::regprocedure);
 execute replace(d,$anchor$'readEfficiencyVersion',1$anchor$,$replacement$'readEfficiencyVersion',1,'discoveryRefreshedAt',(select refreshed_at from khub_bot.public_discovery_snapshot where singleton),'discoveryStale',not exists(select 1 from khub_bot.public_discovery_snapshot where refreshed_at>now()-interval '5 minutes')$replacement$);
end;$$;
notify pgrst,'reload schema';
commit;
