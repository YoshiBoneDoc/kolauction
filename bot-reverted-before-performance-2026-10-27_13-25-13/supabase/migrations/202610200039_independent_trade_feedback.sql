-- Apply after 038. Trade responses and optional feedback are independent.
-- Historical confirmations/reports remain responses; never manufacture thumb votes.
begin;
create table khub_bot.trade_feedback (
    auction_id uuid not null references public.auctions(id),
    actor_id uuid not null references public.profiles(id),
    recipient_id uuid not null references public.profiles(id),
    recipient_role text not null check (recipient_role in ('seller','buyer')),
    rating smallint not null check (rating in (-1,1)),
    created_at timestamptz not null default clock_timestamp(),
    updated_at timestamptz not null default clock_timestamp(),
    primary key (auction_id,actor_id),
    check (actor_id<>recipient_id)
);
alter table khub_bot.trade_feedback enable row level security;
revoke all on khub_bot.trade_feedback from public,anon,authenticated;
grant all on khub_bot.trade_feedback to service_role;

create function public.rate_trade_partner(p_auction_id uuid,p_rating integer) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; actor uuid:=auth.uid(); responded boolean;
begin
    if not khub_bot.can_view_usernames() then raise exception 'Log in with an unrestricted account to rate a trade.' using errcode='42501'; end if;
    if p_rating is null or p_rating not in (-1,1) then raise exception 'Choose thumbs up or thumbs down.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.id is null or a.escrow_mode or a.finalized_at is null or a.winner_id is null
        or a.seller_id=a.winner_id or a.status not in ('awaiting_trade','completed')
        or actor not in (a.seller_id,a.winner_id) then
        raise exception 'Only the seller or winning buyer of a closed direct sale can rate their trading partner.';
    end if;
    responded:=case when actor=a.seller_id then coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null
        else coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null end
        or exists(select 1 from khub_bot.trade_reports t where t.auction_id=a.id and t.reporter_id=actor);
    if not responded then raise exception 'Mark the trade complete or incomplete before rating your trading partner.'; end if;
    insert into khub_bot.trade_feedback(auction_id,actor_id,recipient_id,recipient_role,rating)
        values(a.id,actor,case when actor=a.seller_id then a.winner_id else a.seller_id end,
            case when actor=a.seller_id then 'buyer' else 'seller' end,p_rating)
        on conflict (auction_id,actor_id) do update set rating=excluded.rating,updated_at=clock_timestamp()
        where khub_bot.trade_feedback.rating<>excluded.rating;
end; $$;
revoke all on function public.rate_trade_partner(uuid,integer) from public,anon,authenticated;
grant execute on function public.rate_trade_partner(uuid,integer) to authenticated;

create or replace function khub_bot.profile_feedback(p_user uuid) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object(
    'seller_positive',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='seller' and rating=1),
    'seller_negative',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='seller' and rating=-1),
    'buyer_positive',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='buyer' and rating=1),
    'buyer_negative',(select count(*) from khub_bot.trade_feedback where recipient_id=p_user and recipient_role='buyer' and rating=-1),
    'seller_confirmed',(select count(*) from public.auctions a where not a.escrow_mode and a.seller_id=p_user
        and a.finalized_at is not null and a.winner_id is not null and coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null and a.status in ('awaiting_trade','completed')),
    'buyer_confirmed',(select count(*) from public.auctions a where not a.escrow_mode and a.winner_id=p_user
        and a.finalized_at is not null and coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null and a.status in ('awaiting_trade','completed')),
    'seller_incomplete',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode and t.reporter_role='buyer' and a.seller_id=p_user),
    'buyer_incomplete',(select count(*) from khub_bot.trade_reports t join public.auctions a on a.id=t.auction_id
        where t.counts_negative and t.withdrawn_at is null and not a.escrow_mode and t.reporter_role='seller' and a.winner_id=p_user)
);
$$;

-- Extend the existing explicit privacy projection with only the viewer's own vote.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_feedback;
revoke all on function khub_bot.public_auction_before_feedback(public.auctions,bigint,text,text) from public,anon,authenticated;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_feedback(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('own_feedback',case when khub_bot.can_view_usernames()
            and auth.uid() in (a.seller_id,a.winner_id) then
            (select f.rating from khub_bot.trade_feedback f where f.auction_id=a.id and f.actor_id=auth.uid()) end);
$$;
revoke all on function khub_bot.public_auction(public.auctions,bigint,text,text) from public,anon,authenticated;

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
        ||case when v_positive then ' marked the trade Confirmed Complete: they received your side of the exchange.'
            else ' marked the trade Reported Incomplete: they reported that you did not complete your side of the exchange.' end
        ||E'\n\nThis records trade completion only and does not change your feedback score.'
        ||case when v_positive then E'\nThe sale completes once both parties confirm completion.'
            else E'\nPlease contact the other party to resolve the issue. They can use Mark Trade Complete on the auction page after the exchange is completed.'
                ||E'\nUse Contact an Administrator on the auction page if you need to clarify something.' end
        ||E'\n\nView this auction and your profile on kHub for the current status and rating totals.';
    insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
        values('rating-notice:'||a.id||':'||p_actor||':'||case when v_positive then 'positive' else 'negative' end,recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
    insert into khub_bot.rating_notifications(auction_id,actor_id,recipient_id,positive,recipient_role,delivery_id)
        values(a.id,p_actor,recipient.id,v_positive,v_role,delivery);
    return delivery;
end; $$;

create or replace function public.withdraw_trade_rating(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t khub_bot.trade_reports%rowtype; a public.auctions%rowtype; recipient public.profiles%rowtype;
    actor_name text; body text; delivery uuid; resolved_time timestamptz:=clock_timestamp();
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    select * into t from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() for update;
    if t.report_id is null or a.escrow_mode or a.finalized_at is null then raise exception 'Only the author can withdraw this incomplete report.'; end if;
    if t.withdrawn_at is not null then return; end if;
    insert into khub_bot.trade_rating_withdrawals(report_id,withdrawn_by,previous_counted)
        values(t.report_id,auth.uid(),t.counts_negative);
    update khub_bot.trade_reports set counts_negative=false,withdrawn_at=resolved_time where report_id=t.report_id;
    update khub_bot.bug_reports set status='resolved',resolution_kind='participant_resolved',resolved_by=auth.uid(),resolved_at=resolved_time where id=t.report_id;
    -- Separate timestamps preserve neutral completion. Positive counts and
    -- positive-notice triggers use only seller_confirmed_at/buyer_confirmed_at.
    update public.auctions set
        seller_resolved_at=case when t.reporter_role='seller' then resolved_time else seller_resolved_at end,
        buyer_resolved_at=case when t.reporter_role='buyer' then resolved_time else buyer_resolved_at end
        where id=a.id;
    select * into recipient from public.profiles where id=case when t.reporter_role='seller' then a.winner_id else a.seller_id end;
    select khub_username into actor_name from public.profiles where id=auth.uid();
    if recipient.kol_player_id is not null and recipient.kol_verified_at is not null then
        body:='Auction #'||coalesce(a.auction_number::text,a.id::text)||E'\n\n'
            ||khub_bot.escape_report_kmail(actor_name)||' withdrew their incomplete report and confirmed that the issue was resolved and the trade was successfully completed.'
            ||E'\nTheir incomplete report has been withdrawn. Your feedback score is unchanged.';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('rating-withdrawal:'||a.id||':'||auth.uid(),recipient.kol_player_id,'notice',body,body,'') returning id into delivery;
        update khub_bot.trade_reports set withdrawal_delivery_id=delivery where report_id=t.report_id;
    end if;
end; $$;

create or replace function public.confirm_auction_trade(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.escrow_mode then raise exception 'Escrow delivery is confirmed by the bot, not by participants.'; end if;
    if (auth.uid()=a.seller_id and a.seller_resolved_at is not null)
        or (auth.uid()=a.winner_id and a.buyer_resolved_at is not null) then
        raise exception 'You already confirmed this trade complete by withdrawing an incomplete report.';
    end if;
    if exists(select 1 from khub_bot.trade_reports where auction_id=p_auction_id and reporter_id=auth.uid() and withdrawn_at is null) then
        raise exception 'You already reported a trade issue. An administrator must review any correction.';
    end if;
    perform public.legacy_confirm_auction_trade(p_auction_id);
end; $$;

notify pgrst,'reload schema';
commit;
