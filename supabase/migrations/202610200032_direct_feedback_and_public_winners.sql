-- Apply after 031. Participant thumbs-downs count immediately until an administrator excludes them.
-- Winner public names appear only after server-finalized bidding. Trading contacts remain private.
begin;
alter table khub_bot.bug_reports drop constraint bug_reports_body_check;
alter table khub_bot.bug_reports add constraint bug_reports_body_check check(char_length(body) between 1 and 2000);
alter table khub_bot.trade_reports add column counts_negative boolean not null default true,
    add column has_explanation boolean not null default true;
create table khub_bot.trade_rating_reviews (
    id bigint generated always as identity primary key,
    report_id uuid not null references khub_bot.bug_reports(id),
    administrator_id uuid not null references public.profiles(id),
    previous_counted boolean not null,
    counted boolean not null,
    reason text not null check(char_length(reason) between 3 and 1000),
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.trade_rating_reviews enable row level security;
revoke all on khub_bot.trade_rating_reviews from public,anon,authenticated;
grant all on khub_bot.trade_rating_reviews to service_role;
grant usage on sequence khub_bot.trade_rating_reviews_id_seq to service_role;

create function public.review_trade_rating(p_report_id uuid,p_counted boolean,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare t khub_bot.trade_reports%rowtype; reason text:=btrim(p_reason,E' \t\r\n');
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_counted is null or reason is null or char_length(reason) not between 3 and 1000 then
        raise exception 'Add a review reason in 3 to 1,000 characters.';
    end if;
    select * into t from khub_bot.trade_reports where report_id=p_report_id for update;
    if not found then raise exception 'Trade feedback not found.'; end if;
    if t.counts_negative=p_counted then return; end if;
    update khub_bot.trade_reports set counts_negative=p_counted where report_id=p_report_id;
    insert into khub_bot.trade_rating_reviews(report_id,administrator_id,previous_counted,counted,reason)
        values(p_report_id,auth.uid(),t.counts_negative,p_counted,reason);
end; $$;
revoke all on function public.review_trade_rating(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.review_trade_rating(uuid,boolean,text) to authenticated;

create function khub_bot.profile_feedback(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object(
    'seller_positive',(select count(*) from public.auctions a where not a.escrow_mode and a.seller_id=p_user
        and a.finalized_at is not null and a.winner_id is not null and a.buyer_confirmed_at is not null
        and a.status in ('awaiting_trade','completed')),
    'buyer_positive',(select count(*) from public.auctions a where not a.escrow_mode and a.winner_id=p_user
        and a.finalized_at is not null and a.seller_confirmed_at is not null and a.status in ('awaiting_trade','completed')),
    'seller_negative',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and not a.escrow_mode and t.reporter_role='buyer' and a.seller_id=p_user),
    'buyer_negative',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and not a.escrow_mode and t.reporter_role='seller' and a.winner_id=p_user)
);
$$;
revoke all on function khub_bot.profile_feedback(uuid) from public,anon,authenticated;

create or replace function public.submit_trade_report(p_request_id uuid,p_auction_id uuid,p_body text default '') returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; prior khub_bot.trade_reports%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(coalesce(p_body,''),E' \t\r\n'); stored_body text;
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
    if p_request_id is null or char_length(v_body)>2000 then
        raise exception 'Keep the optional explanation within 2,000 characters.';
    end if;
    stored_body:=case when v_body='' then 'No explanation provided.' else v_body end;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id<>actor.id or r.body<>stored_body or not exists(select 1 from khub_bot.trade_reports t where t.report_id=r.id and t.auction_id=a.id and t.has_explanation=(v_body<>'')) then
            raise exception 'This report request cannot be reused. Please try a new submission.';
        end if;
        return jsonb_build_object('reference','B-'||r.report_number,'notification',case when v_body='' then 'not_queued' else 'queued' end);
    end if;
    if a.status<>'awaiting_trade' then raise exception 'This trade is not awaiting settlement.'; end if;
    if (actor.id=a.seller_id and a.seller_confirmed_at is not null)
        or (actor.id=a.winner_id and a.buyer_confirmed_at is not null) then
        raise exception 'You already confirmed this trade. Contact an administrator to request a reviewed correction.';
    end if;
    select * into prior from khub_bot.trade_reports where auction_id=a.id and reporter_id=actor.id;
    if found then raise exception 'You already submitted a trade report. Contact an administrator to add information.'; end if;
    if v_body<>'' and exists(select 1 from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 minute' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation)) then
        raise exception 'Please wait a minute before sending another report.';
    end if;
    if v_body<>'' and (select count(*) from khub_bot.bug_reports b where b.reporter_id=actor.id and b.created_at>clock_timestamp()-interval '1 hour' and not exists(select 1 from khub_bot.trade_reports t where t.report_id=b.id and not t.has_explanation))>=5 then
        raise exception 'You have sent several reports recently. Please try again later.';
    end if;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category)
        values(p_request_id,actor.id,actor.khub_username,actor.kol_player_id,stored_body,'trade') returning * into r;
    insert into khub_bot.trade_reports(auction_id,reporter_id,reporter_role,report_id,has_explanation)
        values(a.id,actor.id,case when actor.id=a.seller_id then 'seller' else 'buyer' end,r.id,v_body<>'');

    -- Silent thumbs-downs are inbox records without KMail notifications.
    if v_body='' then
        return jsonb_build_object('reference','B-'||r.report_number,'notification','not_queued');
    end if;

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
        'trade_reported',case when reveal then exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id) end,
        'completed_at',a.completed_at,'cancelled_at',a.cancelled_at,'settlement_contacts',contacts
    );
end; $$;
create or replace function public.read_auction_page(
    p_view text default 'browse', p_id uuid default null,
    p_search text default '', p_status text default 'active',
    p_sort text default 'ending', p_page integer default 1
) returns jsonb language sql stable security definer set search_path='' as $$
with matching as materialized (
    select a.*, (select count(*) from public.bids b where b.auction_id=a.id) as bid_count
    from public.auctions a
    where (a.status<>'pending_escrow' or a.seller_id=auth.uid()) and (
        (p_view='detail' and a.id=p_id)
        or (p_view='profile' and auth.uid() is not null and (
            a.seller_id=auth.uid() or a.winner_id=auth.uid()
            or exists(select 1 from public.bids b where b.auction_id=a.id and b.bidder_id=auth.uid())))
        or (p_view in ('home','browse','seller')
            and (p_view<>'seller' or (a.seller_id=p_id and a.status<>'pending_escrow'))
            and strpos(lower(a.item),lower(btrim(coalesce(p_search,''))))>0
            and case when p_view='home' then a.status='active' and a.end_time>statement_timestamp()
                when p_status='all' then true
                when p_status='ended' then a.status<>'pending_escrow'
                    and (a.status<>'active' or a.end_time<=statement_timestamp())
                when p_status='completed' then a.status='completed'
                else a.status='active' and a.end_time>statement_timestamp() end)
    )
), page as materialized (
    select m.* from matching m order by
        case when p_view='home' then m.bid_count end desc,
        case when p_view='home' or p_sort='ending' then m.end_time end asc,
        case when p_sort='newest' then m.created_at end desc,
        case when p_sort='price-asc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end asc,
        case when p_sort='price-desc' then coalesce(m.final_price,nullif(m.current_bid,0),m.min_bid_meat) end desc,
        m.created_at desc,m.id asc
    limit case when p_view='home' then 4 when p_view in ('browse','seller') then 24 else null end
    offset case when p_view in ('browse','seller') then (greatest(1,least(coalesce(p_page,1),1000000))-1)*24 else 0 end
), labels as materialized (
    -- The same person keeps an alias within this auction only. No account UUID
    -- or deterministic hash can be used to correlate bidders between auctions.
    select b.auction_id,b.bidder_id,
        'Bidder '||row_number() over(partition by b.auction_id order by min(b.created_at),b.bidder_id)::text as label
    from public.bids b where b.auction_id in (select id from page) group by b.auction_id,b.bidder_id
), seller_lots as materialized (
    select a.* from public.auctions a where p_view='seller' and a.seller_id=p_id and a.status<>'pending_escrow'
), seller_summary as (
    select p.id,p.khub_username as username,
        jsonb_build_object(
            'active',count(*) filter(where a.status='active' and a.end_time>statement_timestamp()),
            'pending',count(*) filter(where a.status in ('settling','awaiting_trade')),
            'unsold',count(*) filter(where a.status='ended_no_bids'),
            'cancelled',count(*) filter(where a.status='cancelled'),
            'escrow_sales',count(*) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),
            'escrow_value',coalesce(sum(a.final_price) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),0)::text,
            'escrow_units',coalesce(sum(a.quantity) filter(where a.status='completed' and a.escrow_mode and a.winner_id is not null),0)::text,
            'legacy_sales',count(*) filter(where a.status='completed' and not a.escrow_mode and a.winner_id is not null),
            'legacy_value',coalesce(sum(a.final_price) filter(where a.status='completed' and not a.escrow_mode and a.winner_id is not null),0)::text
        ) || khub_bot.profile_feedback(p.id) as stats
    from public.profiles p left join seller_lots a on a.seller_id=p.id
    where p_view='seller' and p.id=p_id and (exists(select 1 from seller_lots)
        or exists(select 1 from public.auctions w where w.winner_id=p.id and w.finalized_at is not null
            and w.status in ('awaiting_trade','settling','completed')))
    group by p.id,p.khub_username
)
select jsonb_build_object(
    'privacy_version',1,
    'rows',coalesce((select jsonb_agg(khub_bot.public_auction(a,p.bid_count,h.label,w.label)
        order by p.ordinal) from (select page.*,row_number() over() as ordinal from page) p
        join public.auctions a on a.id=p.id
        left join labels h on h.auction_id=a.id and h.bidder_id=a.highest_bidder_id
        left join labels w on w.auction_id=a.id and w.bidder_id=a.winner_id),'[]'::jsonb),
    'total',(select count(*) from matching),
    'bids',coalesce((select jsonb_agg(jsonb_build_object(
        'id',b.id,'auction_id',b.auction_id,'amount',b.amount,'created_at',b.created_at,
        'bidder_id',case when b.bidder_id=auth.uid() then b.bidder_id end,
        'bidder_username',case when b.bidder_id=auth.uid() then 'You' else l.label end
    ) order by b.amount,b.id) from public.bids b join labels l using(auction_id,bidder_id)
        where p_view='detail' or (p_view='profile' and b.bidder_id=auth.uid())),'[]'::jsonb),
    'seller',(select to_jsonb(s) from seller_summary s)
);
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
            'negative_counted',(select t.counts_negative from khub_bot.trade_reports t where t.report_id=r.id),
            'has_explanation',(select t.has_explanation from khub_bot.trade_reports t where t.report_id=r.id),
            'rating_reviews',(select coalesce(jsonb_agg(jsonb_build_object('counted',v.counted,'reason',v.reason,'created_at',v.created_at,'reviewer',(select p.khub_username from public.profiles p where p.id=v.administrator_id)) order by v.id),'[]'::jsonb) from khub_bot.trade_rating_reviews v where v.report_id=r.id),
            'target_username',(select p.khub_username from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id join public.profiles p on p.id=case when t.reporter_role='buyer' then a.seller_id else a.winner_id end where t.report_id=r.id),
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
