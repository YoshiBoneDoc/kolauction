-- Apply after 030. Private trade reports are allegations for review, not automatic ratings or bans.
begin;
create table khub_bot.trade_reports (
    auction_id uuid not null references public.auctions(id),
    reporter_id uuid not null references public.profiles(id),
    reporter_role text not null check (reporter_role in ('seller','buyer')),
    report_id uuid not null unique references khub_bot.bug_reports(id),
    created_at timestamptz not null default clock_timestamp(),
    primary key(auction_id,reporter_id)
);
alter table khub_bot.trade_reports enable row level security;
revoke all on khub_bot.trade_reports from public,anon,authenticated;
grant all on khub_bot.trade_reports to service_role;

create function public.submit_trade_report(p_request_id uuid,p_auction_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; prior khub_bot.trade_reports%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into actor from public.profiles where id=auth.uid();
    select * into a from public.auctions where id=p_auction_id for update;
    if actor.id is null or actor.kol_verified_at is null or a.id is null or a.escrow_mode
        or a.finalized_at is null or a.winner_id is null or a.seller_id=a.winner_id
        or actor.id not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winning buyer of a closed direct sale can report a trade.';
    end if;
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe what happened in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>v_body or not exists(select 1 from khub_bot.trade_reports t where t.report_id=r.id and t.auction_id=a.id) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
    end if;
    if a.status<>'awaiting_trade' then raise exception 'This trade is not awaiting settlement.'; end if;
    if (actor.id=a.seller_id and a.seller_confirmed_at is not null)
        or (actor.id=a.winner_id and a.buyer_confirmed_at is not null) then
        raise exception 'You already confirmed this trade. Contact an administrator to request a reviewed correction.';
    end if;
    select * into prior from khub_bot.trade_reports where auction_id=a.id and reporter_id=actor.id;
    if found then raise exception 'You already submitted a trade report. Contact an administrator to add information.'; end if;
    if exists(select 1 from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 minute') then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if (select count(*) from khub_bot.bug_reports where reporter_id=actor.id and created_at>clock_timestamp()-interval '1 hour')>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,v_body,'trade') returning * into r;
    insert into khub_bot.trade_reports(auction_id,reporter_id,reporter_role,report_id)
        values(a.id,actor.id,case when actor.id=a.seller_id then 'seller' else 'buyer' end,r.id);

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
        message:='Trade report B-'||r.report_number||' ('||i||'/'||array_length(parts,1)||')'
            ||E'\nAuction #'||a.auction_number||' ('||a.id||')'
            ||E'\nAgreed total: '||a.final_price||' Meat'
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('trade-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

create or replace function public.confirm_auction_trade(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if exists(select 1 from public.auctions where id=p_auction_id and escrow_mode) then
        raise exception 'Escrow delivery is confirmed by the bot, not by participants.';
    end if;
    if exists(select 1 from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid()) then
        raise exception 'You already reported a trade issue. An administrator must review any correction.';
    end if;
    perform public.legacy_confirm_auction_trade(p_auction_id);
end; $$;
revoke all on function public.submit_trade_report(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.submit_trade_report(uuid,uuid,text) to authenticated;

create or replace function khub_bot.public_auction(
    a public.auctions, p_bid_count bigint, p_highest_label text, p_winner_label text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
    viewer uuid := auth.uid();
    reveal boolean := not a.escrow_mode and a.finalized_at is not null
        and a.status in ('awaiting_trade','completed') and a.winner_id is not null
        and (viewer=a.seller_id or viewer=a.winner_id);
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
        'winner_id',case when a.winner_id=viewer or reveal then a.winner_id end,
        'winner_username',case when a.winner_id is null then null when reveal then a.winner_username
            when a.winner_id=viewer then 'You' else coalesce(p_winner_label,'Anonymous bidder') end,
        'final_price',a.final_price,'finalized_at',a.finalized_at,
        'seller_confirmed_at',a.seller_confirmed_at,'buyer_confirmed_at',a.buyer_confirmed_at,
        'own_trade_report',case when reveal then (select 'B-'||b.report_number from khub_bot.trade_reports t join khub_bot.bug_reports b on b.id=t.report_id where t.auction_id=a.id and t.reporter_id=viewer) end,
        'trade_reported',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;
create or replace function public.read_pending_trades(p_page integer default 1) returns jsonb
language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.* from public.auctions a
    where auth.uid() is not null and not a.escrow_mode and a.status='awaiting_trade'
        and a.finalized_at is not null and a.winner_id is not null
        and not exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=auth.uid())
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

create or replace function public.read_support_inbox(p_category text default 'all',p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('all','bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    if p_status is null or p_status not in ('open','resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    with matching as materialized (
        select * from khub_bot.bug_reports where (p_status='all' or status=p_status) and (p_category='all' or category=p_category)
    ), page as (
        select * from matching order by created_at desc,report_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'reports',
        coalesce((select jsonb_agg(jsonb_build_object(
            'auction_id',(select t.auction_id from khub_bot.trade_reports t where t.report_id=r.id),
            'reporter_role',(select t.reporter_role from khub_bot.trade_reports t where t.report_id=r.id),
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

notify pgrst,'reload schema';
commit;
