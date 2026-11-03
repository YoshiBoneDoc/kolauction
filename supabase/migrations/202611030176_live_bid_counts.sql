-- After 175. Quiet-period backfill: fail quickly rather than queue behind bids.
begin;
set local lock_timeout='2s';
lock table public.bids in share row exclusive mode;
alter table public.auctions add column display_bid_count bigint not null default 0 check(display_bid_count>=0),
 add column display_bid_revision bigint not null default 0;
update public.auctions a set display_bid_count=(select count(*) from public.bids b where b.auction_id=a.id);
create function khub_bot.update_display_bid_count() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if tg_op='UPDATE' and new.auction_id=old.auction_id then
        update public.auctions set display_bid_revision=display_bid_revision+1 where id=new.auction_id;
        return null;
    end if;
    -- Order locks for the supported case of moving a bid between auctions.
    if tg_op='UPDATE' then
        perform 1 from public.auctions where id in(old.auction_id,new.auction_id) order by id for update;
    end if;
    if tg_op<>'INSERT' then update public.auctions set display_bid_count=display_bid_count-1,display_bid_revision=display_bid_revision+1 where id=old.auction_id; end if;
    if tg_op<>'DELETE' then update public.auctions set display_bid_count=display_bid_count+1,display_bid_revision=display_bid_revision+1 where id=new.auction_id; end if;
    return null;
end;$$;
revoke all on function khub_bot.update_display_bid_count() from public,anon,authenticated,service_role;
create trigger update_display_bid_count after insert or delete or update on public.bids
for each row execute function khub_bot.update_display_bid_count();
-- Display readers only. Financial function definitions are untouched.
do $$declare f record; d text;begin
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in('public','khub_bot') and p.prokind='f'
 and (p.proname like 'read_%' or p.proname='public_listing_page')
 and strpos(p.prosrc,'(select count(*) from public.bids b where b.auction_id=a.id)')>0 loop
 d:=pg_get_functiondef(f.oid);
 execute replace(d,'(select count(*) from public.bids b where b.auction_id=a.id)','a.display_bid_count');
 end loop;
end;$$;
-- Discovery ranking also reuses the same transactionally maintained counts.
create or replace function khub_bot.hot_auction_ids() returns setof uuid
language sql stable security definer set search_path='' as $$
 with active_counts as materialized (
   select a.id,a.created_at,a.display_bid_count as bid_count from public.auctions a
   where a.status='active' and a.end_time>statement_timestamp()
     and not khub_bot.profile_is_restricted(a.seller_id)
 ) select id from active_counts where bid_count>0
 order by bid_count desc,created_at asc,id asc
 limit (select (count(*)+9)/10 from active_counts);
$$;
notify pgrst,'reload schema';
commit;
