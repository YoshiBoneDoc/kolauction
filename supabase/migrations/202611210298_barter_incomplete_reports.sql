-- Apply once after 297. Reports are not completion confirmations.
begin;
create table khub_bot.barter_trade_reports (
 auction_id uuid not null references khub_bot.barter_auctions(id),
 actor_id uuid not null references public.profiles(id),
 report_id uuid not null unique references khub_bot.bug_reports(id),
 rating smallint check(rating in (-1,1)),
 primary key(auction_id,actor_id)
);
alter table khub_bot.barter_trade_reports enable row level security;
revoke all on khub_bot.barter_trade_reports from public,anon,authenticated;
grant all on khub_bot.barter_trade_reports to service_role;
create function public.report_barter_incomplete(p_id uuid,p_request uuid,p_body text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare a khub_bot.barter_auctions%rowtype; bidder uuid; recipient public.profiles%rowtype; result jsonb; existing uuid; body text;
begin
 if auth.uid() is null or not khub_bot.can_view_usernames() then raise exception 'Sign in with an eligible account.'; end if;
 if p_request is null or p_body is null or length(p_body)>1800 then raise exception 'Keep the explanation within 1,800 characters.'; end if;
 select * into a from khub_bot.barter_auctions where id=p_id for update;
 if not found then raise exception 'Barter unavailable.'; end if;
 select bidder_id into bidder from khub_bot.barter_offers where id=a.current_offer_id and auction_id=a.id and status='accepted';
 if a.cancelled_at is not null or a.end_time>clock_timestamp() or bidder is null or auth.uid() not in (a.seller_id,bidder) then raise exception 'Only participants in a concluded barter can report.'; end if;
 select report_id into existing from khub_bot.barter_trade_reports where auction_id=a.id and actor_id=auth.uid();
 if found then return jsonb_build_object('saved',true); end if;
 if exists(select 1 from khub_bot.barter_trade_responses where auction_id=a.id and actor_id=auth.uid()) then raise exception 'You already confirmed completion. Contact an administrator for a reviewed correction.'; end if;
 body:='Incomplete barter /barter/'||a.id||E'\nOther participant: '||case when auth.uid()=a.seller_id then bidder else a.seller_id end||E'\n'||btrim(p_body);
 result:=public.submit_support_ticket(p_request,body);
 insert into khub_bot.barter_trade_reports(auction_id,actor_id,report_id) values(a.id,auth.uid(),p_request);
 select * into recipient from public.profiles where id=case when auth.uid()=a.seller_id then bidder else a.seller_id end;
 if recipient.kol_player_id is not null and recipient.kol_verified_at is not null then
 body:='The other player reported your barter exchange incomplete. Please contact them to resolve the issue. View /barter/'||a.id||' on kHub. This report does not change your feedback score.';
 insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer) values('barter-incomplete:'||a.id||':'||auth.uid(),recipient.kol_player_id,'notice',body,body,'');
 end if;
 return result;
end; $$;
-- Serialize completion and reports on the same listing lock.
alter function public.confirm_barter_trade(uuid) rename to confirm_barter_trade_before_reports;
revoke all on function public.confirm_barter_trade_before_reports(uuid) from public,anon,authenticated;
create function public.confirm_barter_trade(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform 1 from khub_bot.barter_auctions where id=p_id for update;
 if exists(select 1 from khub_bot.barter_trade_reports where auction_id=p_id and actor_id=auth.uid()) then raise exception 'You already reported this trade. Contact an administrator for a reviewed correction.'; end if;
 perform public.confirm_barter_trade_before_reports(p_id);
end; $$;
alter function public.read_barter_trades() rename to read_barter_trades_before_reports;
revoke all on function public.read_barter_trades_before_reports() from public,anon,authenticated;
create function public.read_barter_trades() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(t.row||jsonb_build_object('reported',r.actor_id is not null,'rating',coalesce(r.rating,(t.row->>'rating')::integer)) order by t.n),'[]'::jsonb)
 from jsonb_array_elements(public.read_barter_trades_before_reports()) with ordinality t(row,n)
 left join khub_bot.barter_trade_reports r on r.auction_id=(t.row->>'id')::uuid and r.actor_id=auth.uid()
 where r.rating is null;
$$;
alter function public.rate_barter_partner(uuid,integer) rename to rate_barter_partner_before_reports;
revoke all on function public.rate_barter_partner_before_reports(uuid,integer) from public,anon,authenticated;
create function public.rate_barter_partner(p_id uuid,p_rating integer) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null or not khub_bot.can_view_usernames() then raise exception 'Sign in with an eligible account.'; end if;
 if p_rating is null or p_rating not in (-1,1) then raise exception 'Choose thumbs up or thumbs down.'; end if;
 perform 1 from khub_bot.barter_auctions where id=p_id for update;
 if exists(select 1 from khub_bot.barter_trade_reports where auction_id=p_id and actor_id=auth.uid()) then
 update khub_bot.barter_trade_reports set rating=p_rating where auction_id=p_id and actor_id=auth.uid() and rating is null;
 if exists(select 1 from khub_bot.barter_trade_reports where auction_id=p_id and actor_id=auth.uid() and rating<>p_rating) then raise exception 'Your rating cannot be changed.'; end if;
 else perform public.rate_barter_partner_before_reports(p_id,p_rating); end if;
end; $$;
revoke all on function public.report_barter_incomplete(uuid,uuid,text),public.confirm_barter_trade(uuid),public.read_barter_trades(),public.rate_barter_partner(uuid,integer) from public,anon,authenticated;
grant execute on function public.report_barter_incomplete(uuid,uuid,text),public.confirm_barter_trade(uuid),public.read_barter_trades(),public.rate_barter_partner(uuid,integer) to authenticated;
alter function khub_bot.profile_feedback(uuid) rename to profile_feedback_before_barter_reports;
revoke all on function khub_bot.profile_feedback_before_barter_reports(uuid) from public,anon,authenticated;
create function khub_bot.profile_feedback(p_user uuid) returns jsonb language sql stable security definer set search_path='' as $$
 with votes as (
 select r.rating,case when r.actor_id=a.seller_id then o.bidder_id else a.seller_id end recipient,
 case when r.actor_id=a.seller_id then 'buyer' else 'seller' end role
 from khub_bot.barter_trade_reports r join khub_bot.barter_auctions a on a.id=r.auction_id
 join khub_bot.barter_offers o on o.id=a.current_offer_id
 ), totals as (
 select count(*) filter(where role='seller' and rating=1) sp,count(*) filter(where role='seller' and rating=-1) sn,
 count(*) filter(where role='buyer' and rating=1) bp,count(*) filter(where role='buyer' and rating=-1) bn from votes where recipient=p_user
 ), base as (select khub_bot.profile_feedback_before_barter_reports(p_user) j)
 select j||jsonb_build_object('seller_positive',(j->>'seller_positive')::bigint+sp,'seller_negative',(j->>'seller_negative')::bigint+sn,
 'buyer_positive',(j->>'buyer_positive')::bigint+bp,'buyer_negative',(j->>'buyer_negative')::bigint+bn) from base,totals;
$$;
revoke all on function khub_bot.profile_feedback(uuid) from public,anon,authenticated;
notify pgrst,'reload schema';
commit;
