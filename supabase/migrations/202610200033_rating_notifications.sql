-- Apply after 032. New direct feedback queues one durable notice to the rated player.
-- Existing feedback is not mass-notified; administrators can queue missing notices per auction.
begin;
create table khub_bot.rating_notifications (
    auction_id uuid not null references public.auctions(id),
    actor_id uuid not null references public.profiles(id),
    recipient_id uuid not null references public.profiles(id),
    positive boolean not null,
    recipient_role text not null check(recipient_role in ('seller','buyer')),
    delivery_id uuid not null unique references khub_bot.deliveries(id),
    created_at timestamptz not null default clock_timestamp(),
    primary key(auction_id,actor_id),
    check(actor_id<>recipient_id)
);
alter table khub_bot.rating_notifications enable row level security;
revoke all on khub_bot.rating_notifications from public,anon,authenticated;
grant all on khub_bot.rating_notifications to service_role;

create function khub_bot.queue_rating_notice(p_auction uuid,p_actor uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; recipient public.profiles%rowtype; actor_name text;
    v_positive boolean; v_role text; delivery uuid; body text;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or p_actor is null or p_actor not in (a.seller_id,a.winner_id) then return null; end if;
    select delivery_id into delivery from khub_bot.rating_notifications where auction_id=a.id and actor_id=p_actor;
    if found then return delivery; end if;
    v_positive:=case when p_actor=a.seller_id then a.seller_confirmed_at is not null else a.buyer_confirmed_at is not null end;
    if not v_positive and not exists(select 1 from khub_bot.trade_reports t
        where t.auction_id=a.id and t.reporter_id=p_actor and t.counts_negative) then return null; end if;
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
            else E'\nThis is participant feedback. An administrator can exclude the negative count after review.' end
        ||E'\n\nView this auction and your profile on kHub for the current status and rating totals.';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('rating-notice:'||a.id||':'||p_actor,recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
    insert into khub_bot.rating_notifications(auction_id,actor_id,recipient_id,positive,recipient_role,delivery_id)
        values(a.id,p_actor,recipient.id,v_positive,v_role,delivery);
    return delivery;
end; $$;
revoke all on function khub_bot.queue_rating_notice(uuid,uuid) from public,anon,authenticated;

create function khub_bot.notify_positive_rating() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if not new.escrow_mode then
        if old.seller_confirmed_at is null and new.seller_confirmed_at is not null then
            perform khub_bot.queue_rating_notice(new.id,new.seller_id);
        end if;
        if old.buyer_confirmed_at is null and new.buyer_confirmed_at is not null then
            perform khub_bot.queue_rating_notice(new.id,new.winner_id);
        end if;
    end if;
    return new;
end; $$;
create trigger auctions_notify_positive_rating after update of seller_confirmed_at,buyer_confirmed_at on public.auctions
    for each row execute function khub_bot.notify_positive_rating();
create function khub_bot.notify_negative_rating() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.counts_negative then perform khub_bot.queue_rating_notice(new.auction_id,new.reporter_id); end if;
    return new;
end; $$;
create trigger trade_reports_notify_negative_rating after insert on khub_bot.trade_reports
    for each row execute function khub_bot.notify_negative_rating();
revoke all on function khub_bot.notify_positive_rating(),khub_bot.notify_negative_rating() from public,anon,authenticated;

create function khub_bot.missing_rating_notices(p_auction uuid) returns bigint
language sql stable security definer set search_path='' as $$
    select count(*) from public.auctions a cross join lateral (values(a.seller_id,a.seller_confirmed_at),(a.winner_id,a.buyer_confirmed_at)) r(actor,confirmed)
    where a.id=p_auction and not a.escrow_mode and a.finalized_at is not null and a.winner_id is not null
        and a.status in ('awaiting_trade','completed') and a.seller_id<>a.winner_id
        and (r.confirmed is not null or exists(select 1 from khub_bot.trade_reports t
            where t.auction_id=a.id and t.reporter_id=r.actor and t.counts_negative))
        and not exists(select 1 from khub_bot.rating_notifications n where n.auction_id=a.id and n.actor_id=r.actor);
$$;
revoke all on function khub_bot.missing_rating_notices(uuid) from public,anon,authenticated;
create function public.notify_auction_ratings(p_auction_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; before_count bigint; after_count bigint;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id;
    if a.id is null or a.escrow_mode then raise exception 'Choose a direct-settlement auction.'; end if;
    select count(*) into before_count from khub_bot.rating_notifications where auction_id=a.id;
    perform khub_bot.queue_rating_notice(a.id,a.seller_id);
    perform khub_bot.queue_rating_notice(a.id,a.winner_id);
    select count(*) into after_count from khub_bot.rating_notifications where auction_id=a.id;
    return jsonb_build_object('queued',after_count-before_count,'remaining',khub_bot.missing_rating_notices(a.id));
end; $$;
revoke all on function public.notify_auction_ratings(uuid) from public,anon,authenticated;
grant execute on function public.notify_auction_ratings(uuid) to authenticated;

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
            'missing_rating_notices',(select khub_bot.missing_rating_notices(t.auction_id) from khub_bot.trade_reports t where t.report_id=r.id),
            'rating_notification',(select case d.state when 'sent' then 'sent' when 'unknown' then 'needs_review' when 'sending' then 'sending' else 'queued' end from khub_bot.trade_reports t join khub_bot.rating_notifications n on n.auction_id=t.auction_id and n.actor_id=t.reporter_id join khub_bot.deliveries d on d.id=n.delivery_id where t.report_id=r.id),
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
