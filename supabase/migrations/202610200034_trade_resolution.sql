-- Apply after 033. Author withdrawals preserve feedback history and resolve its inbox entry.
begin;
alter table khub_bot.trade_reports add column withdrawn_at timestamptz,
    add column withdrawal_delivery_id uuid references khub_bot.deliveries(id);
alter table khub_bot.bug_reports add column resolution_kind text check(resolution_kind in ('administrator','participant_resolved'));
create table khub_bot.trade_rating_withdrawals (
    report_id uuid primary key references khub_bot.bug_reports(id),
    withdrawn_by uuid not null references public.profiles(id),
    previous_counted boolean not null,
    created_at timestamptz not null default clock_timestamp()
);
create table khub_bot.trade_queries (
    report_id uuid primary key references khub_bot.bug_reports(id),
    auction_id uuid not null references public.auctions(id),
    requester_id uuid not null references public.profiles(id)
);
alter table khub_bot.trade_rating_withdrawals enable row level security;
alter table khub_bot.trade_queries enable row level security;
revoke all on khub_bot.trade_rating_withdrawals,khub_bot.trade_queries from public,anon,authenticated;
grant all on khub_bot.trade_rating_withdrawals,khub_bot.trade_queries to service_role;
alter table khub_bot.rating_notifications drop constraint rating_notifications_pkey;
alter table khub_bot.rating_notifications add primary key(auction_id,actor_id,positive);

create function public.withdraw_trade_rating(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t khub_bot.trade_reports%rowtype; a public.auctions%rowtype; recipient public.profiles%rowtype;
    actor_name text; body text; delivery uuid;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    select * into t from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() for update;
    if t.report_id is null or a.escrow_mode or a.finalized_at is null then raise exception 'Only the author can withdraw this negative response.'; end if;
    if t.withdrawn_at is not null then return; end if;
    insert into khub_bot.trade_rating_withdrawals(report_id,withdrawn_by,previous_counted)
        values(t.report_id,auth.uid(),t.counts_negative);
    update khub_bot.trade_reports set counts_negative=false,withdrawn_at=clock_timestamp() where report_id=t.report_id;
    update khub_bot.bug_reports set status='resolved',resolution_kind='participant_resolved',resolved_by=auth.uid(),resolved_at=clock_timestamp() where id=t.report_id;
    select * into recipient from public.profiles where id=case when t.reporter_role='seller' then a.winner_id else a.seller_id end;
    select khub_username into actor_name from public.profiles where id=auth.uid();
    if recipient.kol_player_id is not null and recipient.kol_verified_at is not null then
        body:='Auction #'||coalesce(a.auction_number::text,a.id::text)||E'\n\n'
            ||khub_bot.escape_report_kmail(actor_name)||' withdrew their thumbs down. Their negative rating no longer counts against your profile.'
            ||E'\nThis does not by itself confirm completion. View the auction on kHub for its current status.';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('rating-withdrawal:'||a.id||':'||auth.uid(),recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
        update khub_bot.trade_reports set withdrawal_delivery_id=delivery where report_id=t.report_id;
    end if;
end; $$;
revoke all on function public.withdraw_trade_rating(uuid) from public,anon,authenticated;
grant execute on function public.withdraw_trade_rating(uuid) to authenticated;

create or replace function public.review_trade_rating(p_report_id uuid,p_counted boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare t khub_bot.trade_reports%rowtype; reason text:=btrim(p_reason,E' \t\r\n');
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_counted is null or reason is null or char_length(reason) not between 3 and 1000 then
        raise exception 'Add a review reason in 3 to 1,000 characters.';
    end if;
    select * into t from khub_bot.trade_reports where report_id=p_report_id for update;
    if not found then raise exception 'Trade feedback not found.'; end if;
    if p_counted and t.withdrawn_at is not null then raise exception 'This feedback was withdrawn by its author and cannot be restored.'; end if;
    if t.counts_negative=p_counted then return; end if;
    update khub_bot.trade_reports set counts_negative=p_counted where report_id=p_report_id;
    insert into khub_bot.trade_rating_reviews(report_id,administrator_id,previous_counted,counted,reason)
        values(p_report_id,auth.uid(),t.counts_negative,p_counted,reason);
end; $$;
create or replace function khub_bot.queue_rating_notice(p_auction uuid,p_actor uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; recipient public.profiles%rowtype; actor_name text;
    v_positive boolean; v_role text; delivery uuid; body text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or p_actor is null or p_actor not in (a.seller_id,a.winner_id) then return null; end if;
    v_positive:=case when p_actor=a.seller_id then a.seller_confirmed_at is not null else a.buyer_confirmed_at is not null end;
    if not v_positive and not exists(select 1 from khub_bot.trade_reports t
        where t.auction_id=a.id and t.reporter_id=p_actor and t.counts_negative and t.withdrawn_at is null) then return null; end if;
    select delivery_id into delivery from khub_bot.rating_notifications where auction_id=a.id and actor_id=p_actor and positive=v_positive;
    if found then return delivery; end if;
    select * into recipient from public.profiles where id=case when p_actor=a.seller_id then a.winner_id else a.seller_id end;
    -- Never guess a recipient number from a username or send to an unverified identity.
    if recipient.kol_player_id is null or recipient.kol_verified_at is null then return null; end if;
    select khub_username into actor_name from public.profiles where id=p_actor;
    v_role:=case when p_actor=a.seller_id then 'buyer' else 'seller' end;
    body:='Auction #'||coalesce(a.auction_number::text,a.id::text)
        ||E'\n'||a.quantity||' x '||khub_bot.escape_report_kmail(left(a.item,80))
        ||E'\nAgreed total: '||a.final_price||' Meat'
        ||E'\n\n'||khub_bot.escape_report_kmail(actor_name)
        ||case when v_positive then ' was satisfied with the trade and gave you a thumbs up.'
            else ' was not satisfied with the trade and gave you a thumbs down.' end
        ||E'\n\nA '||case when v_positive then 'Positive' else 'Negative' end
        ||' rating has been added to your profile as a '||v_role||'. It contributes to your overall reputation.'
        ||case when v_positive then E'\nThis records their response; the sale completes only after both parties confirm.'
            else E'\nPlease contact the other party and try to resolve this with them. They can withdraw their negative rating from this auction on kHub.'
                ||E'\nAs a last resort, use Ask an administrator about this trade on the auction page to send a private Trade query about your concerns.' end
        ||E'\n\nView this auction and your profile on kHub for the current status and rating totals.';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('rating-notice:'||a.id||':'||p_actor||':'||case when v_positive then 'positive' else 'negative' end,recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
    insert into khub_bot.rating_notifications(auction_id,actor_id,recipient_id,positive,recipient_role,delivery_id)
        values(a.id,p_actor,recipient.id,v_positive,v_role,delivery);
    return delivery;
end; $$;
create or replace function khub_bot.missing_rating_notices(p_auction uuid) returns bigint
language sql stable security definer set search_path='' as $$
    select count(*) from public.auctions a cross join lateral (values(a.seller_id,a.seller_confirmed_at),(a.winner_id,a.buyer_confirmed_at)) r(actor,confirmed)
    where a.id=p_auction and not a.escrow_mode and a.finalized_at is not null and a.winner_id is not null
        and a.status in ('awaiting_trade','completed') and a.seller_id<>a.winner_id
        and (r.confirmed is not null or exists(select 1 from khub_bot.trade_reports t
            where t.auction_id=a.id and t.reporter_id=r.actor and t.counts_negative and t.withdrawn_at is null))
        and not exists(select 1 from khub_bot.rating_notifications n where n.auction_id=a.id and n.actor_id=r.actor and n.positive=(r.confirmed is not null));
$$;
create or replace function public.confirm_auction_trade(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then
        raise exception 'Escrow delivery is confirmed by the bot, not by participants.';
    end if;
    if exists(select 1 from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() and withdrawn_at is null) then
        raise exception 'You already reported a trade issue. An administrator must review any correction.';
    end if;
    perform public.legacy_confirm_auction_trade(p_auction_id);
end; $$;
create or replace function khub_bot.public_auction(
    a public.auctions, p_bid_count bigint, p_highest_label text, p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
    viewer uuid := auth.uid();
    reveal boolean := not a.escrow_mode and a.finalized_at is not null
        and a.status in ('awaiting_trade','completed') and a.winner_id is not null
        and (viewer=a.seller_id or viewer=a.winner_id);
    public_winner boolean := a.finalized_at is not null and a.winner_id is not null
        and a.status in ('awaiting_trade','settling','completed');
    contacts jsonb;
begin
    if reveal then
        select jsonb_build_object(
            'seller',jsonb_build_object('username',s.khub_username,
                'kol_name',case when s.kol_verified_at is not null then s.kol_player_name end,
                'kol_player_id',case when s.kol_verified_at is not null then s.kol_player_id end),
            'buyer',jsonb_build_object('username',b.khub_username,
                'kol_name',case when b.kol_verified_at is not null then b.kol_player_name end,
                'kol_player_id',case when b.kol_verified_at is not null then b.kol_player_id end)
        ) into contacts from public.profiles s,public.profiles b
        where s.id=a.seller_id and b.id=a.winner_id;
    end if;
    -- Explicit fields prevent future private columns from becoming public by default.
    return jsonb_build_object(
        'id',a.id,'auction_number',a.auction_number,'seller_id',a.seller_id,
        'seller_username',coalesce((select khub_username from public.profiles where id=a.seller_id),a.seller_username),
        'item',a.item,'item_id',a.item_id,'quantity',a.quantity,'image',a.image,
        'min_bid_meat',a.min_bid_meat,'current_bid',a.current_bid,'bid_count',p_bid_count,
        'duration_hours',a.duration_hours,'created_at',a.created_at,'end_time',a.end_time,'status',a.status,
        'escrow_mode',a.escrow_mode,'start_on_deposit',a.start_on_deposit,
        'item_escrowed_at',a.item_escrowed_at,'settled_at',a.settled_at,
        'settlement_outcome',a.settlement_outcome,'fee_bps',a.fee_bps,'fee_meat',a.fee_meat,
        'instant_purchase_price',a.instant_purchase_price,'instant_purchased_at',a.instant_purchased_at,
        'has_winner',a.winner_id is not null,
        'highest_bidder_id',case when a.highest_bidder_id=viewer or reveal then a.highest_bidder_id end,
        'highest_bidder_username',case when a.highest_bidder_id is null then null
            when reveal then a.highest_bidder_username when a.highest_bidder_id=viewer then 'You'
            else coalesce(p_highest_label,'Anonymous bidder') end,
        'winner_public',public_winner,
        'winner_id',case when public_winner or a.winner_id=viewer or reveal then a.winner_id end,
        'winner_username',case when a.winner_id is null then null
            when public_winner then coalesce((select khub_username from public.profiles where id=a.winner_id),a.winner_username)
            when reveal then a.winner_username
            when a.winner_id=viewer then 'You' else coalesce(p_winner_label,'Anonymous bidder') end,
        'final_price',a.final_price,'finalized_at',a.finalized_at,
        'seller_confirmed_at',a.seller_confirmed_at,'buyer_confirmed_at',a.buyer_confirmed_at,
        'own_trade_report',case when reveal then (select 'B-'||b.report_number from khub_bot.trade_reports t join khub_bot.bug_reports b on b.id=t.report_id where t.auction_id=a.id and t.reporter_id=viewer) end,
        'own_trade_report_withdrawn',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=viewer and t.withdrawn_at is not null) end,
        'trade_reported',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.withdrawn_at is null) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;
create or replace function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where auth.uid() is not null and not a.escrow_mode and a.status='awaiting_trade'
        and a.finalized_at is not null and a.winner_id is not null
        and not exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=auth.uid() and t.withdrawn_at is null)
        and ((a.seller_id=auth.uid() and a.seller_confirmed_at is null)
          or (a.winner_id=auth.uid() and a.buyer_confirmed_at is null))
), page as (
    select * from matching order by finalized_at,id limit 12
    offset (greatest(1,least(coalesce(p_page,1),1000000))-1)*12
)
select jsonb_build_object('privacy_version',1,'total',(select count(*) from matching),
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,
        (select count(*) from public.bids b where b.auction_id=a.id),'Anonymous bidder','Anonymous bidder')
        order by a.finalized_at,a.id) from page a),'[]'::jsonb));
$$;

create function public.submit_trade_query(p_request_id uuid,p_auction_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    select * into actor from public.profiles where id=auth.uid();
    if actor.id is null or actor.kol_player_id is null or actor.kol_verified_at is null then
        raise exception 'Log in with a verified kHub account to submit an appeal.' using errcode='42501';
    end if;
    select * into a from public.auctions where id=p_auction_id;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.status not in ('awaiting_trade','completed') or actor.id not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winner of a closed direct sale can send a trade query.';
    end if;
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe your trade query in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body or not exists(select 1 from khub_bot.trade_queries q where q.report_id=r.id and q.auction_id=a.id) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
    end if;
    if exists(select 1 from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 minute' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=khub_bot.bug_reports.id and not t.has_explanation)) then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if (select count(*) from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 hour' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=khub_bot.bug_reports.id and not t.has_explanation))>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body,'trade') returning * into r;
    insert into khub_bot.trade_queries(report_id,auction_id,requester_id) values(r.id,a.id,actor.id);

    -- Escape user text for KoL display. Split before the transport's normal
    -- delivery marker, without cutting HTML entities or truncating the report.
    for i in 1..char_length(v_body) loop
        encoded:=khub_bot.escape_report_kmail(substr(v_body,i,1));
        if char_length(part)+char_length(encoded)>1000 then
            parts:=array_append(parts,part); part:='';
        end if;
        part:=part||encoded;
    end loop;
    parts:=array_append(parts,part);
    for i in 1..array_length(parts,1) loop
        message:='Trade query B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nAuction #'||coalesce(a.auction_number::text,a.id::text)
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('bug-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

create or replace function public.set_bug_report_status(p_report_id uuid,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare r khub_bot.bug_reports%rowtype;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_status is null or p_status not in ('open','resolved') then raise exception 'Choose a valid report status.'; end if;
    select * into r from khub_bot.bug_reports where id=p_report_id for update;
    if not found then raise exception 'Report not found.'; end if;
    if r.status=p_status then return; end if;
    update khub_bot.bug_reports set status=p_status, resolution_kind=case when p_status='resolved' then 'administrator' end,
        resolved_at=case when p_status='resolved' then clock_timestamp() end,
        resolved_by=case when p_status='resolved' then auth.uid() end where id=p_report_id;
    insert into khub_bot.bug_report_activity(report_id,administrator_id,status) values(p_report_id,auth.uid(),p_status);
end; $$;
create or replace function public.read_support_inbox(p_category text default 'all',p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('all','bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    if p_status is null or p_status not in ('open','resolved','self_resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    with matching as materialized (
        select * from khub_bot.bug_reports where (p_status='all' or status=p_status or (p_status='self_resolved' and status='resolved' and resolution_kind='participant_resolved')) and (p_category='all' or category=p_category)
    ), page as (
        select * from matching order by created_at desc,report_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'reports',
        coalesce((select jsonb_agg(jsonb_build_object(
            'resolution_kind',coalesce(r.resolution_kind,case when r.status='resolved' then 'administrator' end),
            'feedback_withdrawn',(select t.withdrawn_at is not null from khub_bot.trade_reports t where t.report_id=r.id),
            'missing_rating_notices',(select khub_bot.missing_rating_notices(t.auction_id) from khub_bot.trade_reports t where t.report_id=r.id),
            'rating_notification',(select case d.state when 'sent' then 'sent' when 'unknown' then 'needs_review' when 'sending' then 'sending' else 'queued' end from khub_bot.trade_reports t join khub_bot.rating_notifications n on n.auction_id=t.auction_id and n.actor_id=t.reporter_id and not n.positive join khub_bot.deliveries d on d.id=n.delivery_id where t.report_id=r.id),
            'negative_counted',(select t.counts_negative from khub_bot.trade_reports t where t.report_id=r.id),
            'has_explanation',(select t.has_explanation from khub_bot.trade_reports t where t.report_id=r.id),
            'rating_reviews',(select coalesce(jsonb_agg(jsonb_build_object('counted',v.counted,'reason',v.reason,'created_at',v.created_at,'reviewer',(select p.khub_username from public.profiles p where p.id=v.administrator_id)) order by v.id),'[]'::jsonb) from khub_bot.trade_rating_reviews v where v.report_id=r.id),
            'target_username',(select p.khub_username from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id join public.profiles p on p.id=case when t.reporter_role='buyer' then a.seller_id else a.winner_id end where t.report_id=r.id),
            'auction_id',coalesce((select t.auction_id from khub_bot.trade_reports t where t.report_id=r.id),(select q.auction_id from khub_bot.trade_queries q where q.report_id=r.id)),
            'message_type',case when exists(select 1 from khub_bot.trade_queries q where q.report_id=r.id) then 'trade_query' when exists(select 1 from khub_bot.trade_reports t where t.report_id=r.id) then 'trade_rating' else 'general' end,
            'reporter_role',coalesce((select t.reporter_role from khub_bot.trade_reports t where t.report_id=r.id),(select case when q.requester_id=a.seller_id then 'seller' else 'buyer' end from khub_bot.trade_queries q join public.auctions a on a.id=q.auction_id where q.report_id=r.id)),
            'category',r.category,'id',r.id,'reference','B-'||r.report_number,'body',r.body,'status',r.status,'created_at',r.created_at,
            'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
            'resolved_at',r.resolved_at,
            'notification',case
                when not exists(select 1 from khub_bot.bug_report_deliveries l where l.report_id=r.id) then 'not_queued'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='unknown') then 'needs_review'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='sending') then 'sending'
                when not exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state<>'sent') then 'sent'
                else 'queued' end
        ) order by r.created_at desc,r.report_number desc) from page r),'[]'::jsonb)) into result;
    return result;
end; $$;

revoke all on function public.submit_trade_query(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.submit_trade_query(uuid,uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
