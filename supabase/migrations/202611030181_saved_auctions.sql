-- After 180. Apply before deploying website and rebuilding the Oracle bot.
-- Private bookmarks and attachment-free, at-most-once reminders only.
begin;
set local lock_timeout='2s';
create table khub_bot.saved_auctions (
 user_id uuid not null references public.profiles(id) on delete cascade,
 auction_id uuid not null references public.auctions(id) on delete cascade,
 saved boolean not null default true,
 reminder_minutes integer not null default 0 check(reminder_minutes in(0,5,15,30,60,360,720,1440)),
 preference_set_at timestamptz not null default clock_timestamp(),
 saved_at timestamptz not null default clock_timestamp(),
 send_started boolean not null default false,
 attempt uuid, attempted_at timestamptz, recipient_id bigint,
 outcome text check(outcome in('unknown','sent')),
 primary key(user_id,auction_id)
);
alter table khub_bot.saved_auctions enable row level security;
revoke all on khub_bot.saved_auctions from public,anon,authenticated,service_role;
create index saved_reminders_pending on khub_bot.saved_auctions(auction_id)
 where saved and reminder_minutes>0 and attempt is null;

create function public.set_saved_auction(p_id uuid,p_saved boolean,p_minutes integer default 0) returns void
language plpgsql security definer set search_path='' as $$
declare viewer uuid:=auth.uid();
begin
 if viewer is null then raise exception 'Sign in to save auctions.' using errcode='42501';end if;
 if p_saved is null or p_minutes is null or p_minutes not in(0,5,15,30,60,360,720,1440) then raise exception 'Invalid reminder preference.';end if;
 -- Serialize this user's limit checks without acquiring any financial lock.
 perform pg_advisory_xact_lock(hashtextextended(viewer::text,3888785));
 if not p_saved then
   update khub_bot.saved_auctions set saved=false,reminder_minutes=0,preference_set_at=clock_timestamp()
   where user_id=viewer and auction_id=p_id;
   return;
 end if;
 if khub_bot.profile_is_restricted(viewer) then raise exception 'Account access restricted.' using errcode='42501';end if;
 if not exists(select 1 from khub_bot.visible_auctions() a where a.id=p_id
   and (a.status<>'pending_escrow' or a.seller_id=viewer) and not khub_bot.is_abandoned_escrow_draft(a)) then
   raise exception 'Auction unavailable.' using errcode='42501';end if;
 if (select count(*) from khub_bot.saved_auctions where user_id=viewer and saved)>=200
   and not exists(select 1 from khub_bot.saved_auctions where user_id=viewer and auction_id=p_id and saved) then
   raise exception 'Remove a saved auction before adding more (limit 200).';end if;
 insert into khub_bot.saved_auctions(user_id,auction_id,reminder_minutes) values(viewer,p_id,p_minutes)
 on conflict(user_id,auction_id) do update set saved=true,reminder_minutes=excluded.reminder_minutes,
 preference_set_at=case when not saved_auctions.saved or saved_auctions.reminder_minutes<>excluded.reminder_minutes
   then clock_timestamp() else saved_auctions.preference_set_at end,
 saved_at=case when not saved_auctions.saved then clock_timestamp() else saved_auctions.saved_at end;
 -- Deliberately never clear attempt, including after unsave/re-save.
end;$$;

create function public.read_saved_auctions(p_id uuid default null) returns jsonb
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
 where s.user_id=auth.uid() and s.saved and (p_id is null or s.auction_id=p_id)), '[]'::jsonb));
end;$$;

create function public.bot_claim_saved_reminder() returns jsonb
language plpgsql security definer set search_path='' as $$
declare r record; token uuid:=gen_random_uuid();
begin
 -- One optional message per idle pass. Row locks prevent concurrent claims.
 select s.*,a.auction_number,a.item,coalesce(a.escrow_buyout_received_at,a.end_time) as deadline,p.kol_player_id
 into r from khub_bot.saved_auctions s join public.auctions a on a.id=s.auction_id
 join public.profiles p on p.id=s.user_id
 where s.saved and s.reminder_minutes>0 and s.attempt is null and a.status='active'
 and not khub_bot.profile_is_restricted(s.user_id) and not khub_bot.profile_is_restricted(a.seller_id)
 and p.kol_player_id>0 and p.kol_verified_at is not null
 and (a.escrow_mode or not exists(select 1 from public.player_ignores i join public.profiles sp on sp.id=a.seller_id where
   (i.user_id=s.user_id and i.kol_player_id=sp.kol_player_id) or (i.user_id=a.seller_id and i.kol_player_id=p.kol_player_id)))
 and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()
 and coalesce(a.escrow_buyout_received_at,a.end_time)-make_interval(mins=>s.reminder_minutes)>s.preference_set_at
 and coalesce(a.escrow_buyout_received_at,a.end_time)-make_interval(mins=>s.reminder_minutes)
   between statement_timestamp()-interval '5 minutes' and statement_timestamp()
 order by coalesce(a.escrow_buyout_received_at,a.end_time),s.auction_id
 limit 1 for update of s skip locked;
 if not found then return null;end if;
 update khub_bot.saved_auctions set attempt=token,attempted_at=clock_timestamp(),outcome='unknown',recipient_id=r.kol_player_id
 where user_id=r.user_id and auction_id=r.auction_id;
 return jsonb_build_object('id',token,'auction_id',r.auction_id,'auction_number',r.auction_number,
   'item',r.item,'end_time',r.deadline,'recipient_id',r.kol_player_id);
end;$$;
-- Recheck current status, deadline, preferences and recipient immediately before
-- sending. A claim abandoned on restart stays consumed; it is never reclaimed.
create function public.bot_start_saved_reminder(p_attempt uuid) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare deadline timestamptz;
begin
 update khub_bot.saved_auctions s set send_started=true
 from public.auctions a,public.profiles p
 where s.attempt=p_attempt and not s.send_started and s.saved and s.reminder_minutes>0
 and a.id=s.auction_id and a.status='active' and p.id=s.user_id
 and p.kol_player_id=s.recipient_id and p.kol_verified_at is not null
 and not khub_bot.profile_is_restricted(s.user_id) and not khub_bot.profile_is_restricted(a.seller_id)
 and (a.escrow_mode or not exists(select 1 from public.player_ignores i join public.profiles sp on sp.id=a.seller_id where
   (i.user_id=s.user_id and i.kol_player_id=sp.kol_player_id) or (i.user_id=a.seller_id and i.kol_player_id=p.kol_player_id)))
 and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()
 and coalesce(a.escrow_buyout_received_at,a.end_time)-make_interval(mins=>s.reminder_minutes)>s.preference_set_at
 and coalesce(a.escrow_buyout_received_at,a.end_time)-make_interval(mins=>s.reminder_minutes)
   between statement_timestamp()-interval '5 minutes' and statement_timestamp()
 returning coalesce(a.escrow_buyout_received_at,a.end_time) into deadline;
 return deadline;
end;$$;
create function public.bot_ack_saved_reminder(p_attempt uuid) returns void
language sql security definer set search_path='' as $$
 update khub_bot.saved_auctions set outcome='sent' where attempt=p_attempt;
$$;
revoke all on function public.set_saved_auction(uuid,boolean,integer),public.read_saved_auctions(uuid),public.bot_claim_saved_reminder(),public.bot_ack_saved_reminder(uuid),public.bot_start_saved_reminder(uuid) from public,anon,authenticated,service_role;
grant execute on function public.set_saved_auction(uuid,boolean,integer),public.read_saved_auctions(uuid) to authenticated;
grant execute on function public.bot_claim_saved_reminder(),public.bot_ack_saved_reminder(uuid),public.bot_start_saved_reminder(uuid) to service_role;
alter function public.bot_worker_status() rename to bot_worker_status_before_saved_auctions;
create function public.bot_worker_status() returns jsonb
language sql security definer set search_path='' as $$
 select public.bot_worker_status_before_saved_auctions()||jsonb_build_object('savedRemindersVersion',1);
$$;
revoke all on function public.bot_worker_status_before_saved_auctions(),public.bot_worker_status() from public,anon,authenticated,service_role;
grant execute on function public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
