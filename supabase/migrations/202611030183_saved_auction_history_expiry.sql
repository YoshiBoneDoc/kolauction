-- Apply after 182. Profile display only; do not delete reminder attempt records.
begin;
set local lock_timeout='2s';
create function khub_bot.saved_auction_concluded_at(a public.auctions) returns timestamptz
language sql immutable set search_path='' as $$
 select case
 when a.status='completed' then coalesce(a.completed_at,a.settled_at,a.finalized_at,a.end_time)
 when a.status in('cancelled','voided') then coalesce(a.cancelled_at,a.finalized_at,a.end_time)
 when a.status='expired' then coalesce(a.expired_at,a.finalized_at,a.end_time)
 when a.status='ended_no_bids' then coalesce(a.finalized_at,a.end_time)
 else null end;
$$;
revoke all on function khub_bot.saved_auction_concluded_at(public.auctions) from public,anon,authenticated,service_role;

create or replace function public.read_saved_auctions(p_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Sign in to read saved auctions.' using errcode='42501';end if;
 return jsonb_build_object('server_time',statement_timestamp(),'rows',coalesce((
 select jsonb_agg(jsonb_build_object('id',s.auction_id,'reminder_minutes',s.reminder_minutes,
 'reminder_outcome',s.outcome,'reminder_attempted',s.attempt is not null,
 'auction_number',a.auction_number,'item',coalesce(a.item,'Auction unavailable'),
 'status',a.status,'end_time',coalesce(a.escrow_buyout_received_at,a.end_time)) order by s.saved_at desc,s.auction_id)
 from khub_bot.saved_auctions s left join khub_bot.visible_auctions() a on a.id=s.auction_id
 and (a.status<>'pending_escrow' or a.seller_id=auth.uid()) and not khub_bot.is_abandoned_escrow_draft(a)
 where s.user_id=auth.uid() and s.saved and (p_id is null or s.auction_id=p_id)
 -- Only the Profile list ages out. A detail-page bookmark stays saved and can
 -- still be removed; the permanent at-most-once reminder ledger stays intact.
 and (p_id is not null or not exists(select 1 from public.auctions closed where closed.id=s.auction_id
   and khub_bot.saved_auction_concluded_at(closed)<=statement_timestamp()-interval '72 hours'))), '[]'::jsonb));
end;$$;

-- Hidden history must not consume the 200-entry limit and prevent new bookmarks.
do $$declare d text;
 anchor text:='(select count(*) from khub_bot.saved_auctions where user_id=viewer and saved)';
begin
 d:=pg_get_functiondef('public.set_saved_auction(uuid,boolean,integer)'::regprocedure);
 if strpos(d,anchor)=0 then raise exception 'Unexpected saved-auction limit';end if;
 execute replace(d,anchor,$replacement$(select count(*) from khub_bot.saved_auctions s join public.auctions a on a.id=s.auction_id
 where s.user_id=viewer and s.saved and (khub_bot.saved_auction_concluded_at(a) is null
 or khub_bot.saved_auction_concluded_at(a)>statement_timestamp()-interval '72 hours'))$replacement$);
end;$$;
notify pgrst,'reload schema';
commit;
