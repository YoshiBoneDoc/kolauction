-- Apply after 050. Pause direct commitments for review; preserve funded escrow deliveries.
begin;
alter table public.auctions add column ban_review_required boolean not null default false,
    add column ban_hold_started_at timestamptz,
    drop constraint auctions_status_check,
    add constraint auctions_status_check check (status in
        ('pending_escrow','active','on_hold','voided','settling','awaiting_trade','ended_no_bids','cancelled','completed'));

create table khub_bot.auction_ban_reviews (
    id bigint generated always as identity primary key,
    auction_id uuid not null references public.auctions(id),
    administrator_id uuid references public.profiles(id),
    action text not null,
    reason text not null,
    previous_state jsonb not null,
    new_state jsonb not null,
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.auction_ban_reviews enable row level security;
revoke all on khub_bot.auction_ban_reviews from public,anon,authenticated;
grant all on khub_bot.auction_ban_reviews to service_role;
grant usage on sequence khub_bot.auction_ban_reviews_id_seq to service_role;

create function khub_bot.profile_is_restricted(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
    select coalesce((select khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name)
        from public.profiles p where p.id=p_id),false);
$$;

-- Every ban path (administrator, legacy profile flag, native Auth) uses this table.
-- Take the trading lock before the ban row lock, also for service-role writes.
create function khub_bot.lock_account_restriction() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform pg_advisory_xact_lock(3888760); return null; end; $$;
create trigger account_bans_trading_lock before insert or update on khub_bot.account_bans
    for each statement execute function khub_bot.lock_account_restriction();

create function khub_bot.review_restricted_auctions() returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; updated public.auctions%rowtype; recipient bigint; notice text; review_id bigint;
begin
    perform pg_advisory_xact_lock(3888760);
    for a in select * from public.auctions where
        (status in ('active','pending_escrow') and khub_bot.profile_is_restricted(seller_id))
        or (not escrow_mode and status='active' and khub_bot.profile_is_restricted(highest_bidder_id))
        or (not escrow_mode and status='awaiting_trade' and not ban_review_required
            and (khub_bot.profile_is_restricted(seller_id) or khub_bot.profile_is_restricted(winner_id)))
        order by id for update
    loop
        if a.escrow_mode and a.status='active' then
            -- Items and winning Meat already belong to an existing obligation.
            -- With no funded bids, return the item using the normal delivery ledger.
            if a.highest_bidder_id is null then perform khub_bot.finish_listing(a.id,'cancel'); end if;
            continue;
        elsif a.status='awaiting_trade' then
            update public.auctions set ban_review_required=true where id=a.id;
            notice:='An account restriction affects this trade. Existing trade records are preserved; an administrator can review completion. Do not send further assets without administrator guidance.';
        elsif a.highest_bidder_id is not null then
            update public.auctions set status='on_hold',ban_review_required=true,ban_hold_started_at=clock_timestamp() where id=a.id;
            notice:='This direct auction is on hold for administrator review. Bidding and automatic closing are paused. No winner has been declared.';
        else
            update public.auctions set status='cancelled',cancelled_at=clock_timestamp() where id=a.id;
            notice:='This listing was cancelled following an account restriction before any bids were accepted.';
        end if;
        select * into updated from public.auctions where id=a.id;
        insert into khub_bot.auction_ban_reviews(auction_id,administrator_id,action,reason,previous_state,new_state)
            values(a.id,auth.uid(),'restriction','Account restriction affected an open obligation.',to_jsonb(a),to_jsonb(updated)) returning id into review_id;
        for recipient in select distinct p.kol_player_id from public.profiles p
            where p.id in (a.seller_id,coalesce(a.winner_id,a.highest_bidder_id)) and p.kol_verified_at is not null and p.kol_player_id is not null
        loop
            perform khub_bot.queue('ban-review:'||review_id||':'||recipient,a.id,null,recipient,'notice',0,'[]',
                'Auction #'||a.auction_number||': '||notice);
        end loop;
    end loop;
end; $$;
create function khub_bot.apply_auction_restriction() returns trigger
language plpgsql security definer set search_path='' as $$
begin
    if new.active and (new.expires_at is null or new.expires_at>now()) then
        perform khub_bot.review_restricted_auctions();
    end if;
    return new;
end; $$;
create trigger account_bans_review_auctions after insert or update on khub_bot.account_bans
    for each row execute function khub_bot.apply_auction_restriction();

-- Guard both browser entry points even if an auction predates this migration.
alter function public.place_bid(uuid,bigint) rename to place_bid_before_auction_bans;
create function public.place_bid(p_auction_id uuid,p_amount bigint) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.require_verified_trader();
    select * into a from public.auctions where id=p_auction_id for update;
    if a.status='on_hold' or khub_bot.profile_is_restricted(a.seller_id)
        or (not a.escrow_mode and khub_bot.profile_is_restricted(a.highest_bidder_id)) then
        raise exception 'Bidding is unavailable while this auction is under administrator review.';
    end if;
    perform public.place_bid_before_auction_bans(p_auction_id,p_amount);
end; $$;
alter function public.purchase_auction(uuid) rename to purchase_auction_before_auction_bans;
create function public.purchase_auction(p_auction_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    perform khub_bot.require_verified_trader();
    select * into a from public.auctions where id=p_auction_id for update;
    if a.status='on_hold' or khub_bot.profile_is_restricted(a.seller_id)
        or (not a.escrow_mode and khub_bot.profile_is_restricted(a.highest_bidder_id)) then
        raise exception 'Bidding is unavailable while this auction is under administrator review.';
    end if;
    perform public.purchase_auction_before_auction_bans(p_auction_id);
end; $$;

-- Keep all existing intake validation, deduplication, number formatting and refund
-- behavior. A rejected funded KMail must enter the refund ledger, not abort intake.
do $$ declare definition text; anchor text:='elsif u.id is null then'; begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected escrow intake implementation.'; end if;
    definition:=replace(definition,anchor,
        'elsif khub_bot.profile_is_restricted(a.seller_id) then reason:=''Bidding and deposits are closed for this restricted seller.''; '||anchor);
    execute definition;
end; $$;

-- Explicit public fields only. Never publish ban reasons or administrator notes.
alter function khub_bot.public_auction(public.auctions,bigint,text,text) rename to public_auction_before_ban_review;
create function khub_bot.public_auction(a public.auctions,p_bid_count bigint,p_highest_label text,p_winner_label text)
returns jsonb language sql stable security definer set search_path='' as $$
    select khub_bot.public_auction_before_ban_review(a,p_bid_count,p_highest_label,p_winner_label)
        ||jsonb_build_object('ban_review_required',a.ban_review_required and a.status in ('on_hold','awaiting_trade'),
            'bidding_restricted',a.status='active' and khub_bot.profile_is_restricted(a.seller_id));
$$;

-- A held auction has not ended. Keep it out of ended filters and offer a
-- dedicated review filter without rewriting the existing privacy/page logic.
do $$ declare definition text; anchor text:='when p_status=''completed'' then'; begin
    definition:=pg_get_functiondef('public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure);
    if strpos(definition,anchor)=0 or strpos(definition,'a.status<>''pending_escrow''')=0 then
        raise exception 'Unexpected auction page implementation.';
    end if;
    definition:=replace(definition,'when p_status=''ended'' then a.status<>''pending_escrow''',
        'when p_status=''ended'' then a.status not in (''pending_escrow'',''on_hold'')');
    definition:=replace(definition,anchor,'when p_status=''on_hold'' then a.status=''on_hold'' '||anchor);
    execute definition;
end; $$;

create function public.read_auction_ban_reviews() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    return (select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'number',a.auction_number,'item',a.item,
        'status',a.status,'seller',s.khub_username,'buyer',b.khub_username,
        'seller_complete',coalesce(a.seller_confirmed_at,a.seller_resolved_at) is not null,
        'buyer_complete',coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) is not null,
        'seller_banned',khub_bot.profile_is_restricted(a.seller_id),
        'buyer_banned',khub_bot.profile_is_restricted(coalesce(a.winner_id,a.highest_bidder_id))) order by a.created_at,a.id),'[]'::jsonb)
        from public.auctions a left join public.profiles s on s.id=a.seller_id
        left join public.profiles b on b.id=coalesce(a.winner_id,a.highest_bidder_id)
        where a.ban_review_required and a.status in ('on_hold','awaiting_trade'));
end; $$;

create function public.review_banned_auction(p_auction_id uuid,p_action text,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.auctions%rowtype; updated public.auctions%rowtype; v_reason text:=btrim(p_reason);
    recipient bigint; notice text; review_id bigint;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if v_reason is null or char_length(v_reason) not between 3 and 1000 then raise exception 'Add a review reason in 3 to 1,000 characters.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into a from public.auctions where id=p_auction_id for update;
    if a.id is null or a.escrow_mode or not a.ban_review_required or a.status not in ('on_hold','awaiting_trade') then
        raise exception 'This direct auction is not awaiting ban review.';
    end if;
    if p_action='resume' then
        if khub_bot.profile_is_restricted(a.seller_id) or khub_bot.profile_is_restricted(coalesce(a.winner_id,a.highest_bidder_id)) then
            raise exception 'Lift the affected bans before releasing this auction.';
        end if;
        update public.auctions set ban_review_required=false,ban_hold_started_at=null,
            status=case when status='on_hold' then 'active' else status end,
            end_time=case when status='on_hold' then clock_timestamp()+greatest(end_time-ban_hold_started_at,interval '1 minute') else end_time end
            where id=a.id;
        notice:='The administrator released this auction from review. Check the auction page for its current deadline or trade instructions.';
    elsif p_action='cancel' and a.status='on_hold' then
        update public.auctions set status='voided',cancelled_at=clock_timestamp(),ban_review_required=false where id=a.id;
        notice:='The administrator cancelled this held auction. No winner or completed trade was recorded.';
    elsif p_action in ('seller_complete','buyer_complete') and a.status='awaiting_trade' then
        -- This action is an explicit evidence-based completion decision, unrelated
        -- to resolving a ticket or dismissing an incomplete report.
        if exists(select 1 from khub_bot.trade_reports where auction_id=a.id and counts_negative and withdrawn_at is null
            and reporter_role=case p_action when 'seller_complete' then 'seller' else 'buyer' end) then
            raise exception 'Review and dismiss the outstanding incomplete report before recording this party complete.';
        end if;
        if (case p_action when 'seller_complete' then coalesce(a.seller_confirmed_at,a.seller_resolved_at)
            else coalesce(a.buyer_confirmed_at,a.buyer_resolved_at) end) is not null then
            raise exception 'This party is already recorded complete.';
        end if;
        update public.auctions set
            seller_resolved_at=case when p_action='seller_complete' then clock_timestamp() else seller_resolved_at end,
            buyer_resolved_at=case when p_action='buyer_complete' then clock_timestamp() else buyer_resolved_at end where id=a.id;
        notice:='The administrator reviewed evidence and recorded the '||case p_action when 'seller_complete' then 'seller' else 'buyer' end||' as having received their side of the exchange. Both sides must be recorded complete before the trade counts as completed.';
    else raise exception 'Choose an action appropriate for this auction state.';
    end if;
    select * into updated from public.auctions where id=a.id;
    insert into khub_bot.auction_ban_reviews(auction_id,administrator_id,action,reason,previous_state,new_state)
        values(a.id,auth.uid(),p_action,v_reason,to_jsonb(a),to_jsonb(updated)) returning id into review_id;
    for recipient in select distinct kol_player_id from public.profiles where id in (a.seller_id,coalesce(a.winner_id,a.highest_bidder_id))
        and kol_verified_at is not null and kol_player_id is not null
    loop perform khub_bot.queue('ban-decision:'||review_id||':'||recipient,
        a.id,null,recipient,'notice',0,'[]','Auction #'||a.auction_number||': '||notice); end loop;
end; $$;

revoke all on function khub_bot.profile_is_restricted(uuid),khub_bot.lock_account_restriction(),
    khub_bot.review_restricted_auctions(),khub_bot.apply_auction_restriction(),
    khub_bot.public_auction_before_ban_review(public.auctions,bigint,text,text),
    khub_bot.public_auction(public.auctions,bigint,text,text),
    public.place_bid_before_auction_bans(uuid,bigint),public.purchase_auction_before_auction_bans(uuid),
    public.place_bid(uuid,bigint),public.purchase_auction(uuid),public.read_auction_ban_reviews(),
    public.review_banned_auction(uuid,text,text) from public,anon,authenticated;
grant execute on function public.place_bid(uuid,bigint),public.purchase_auction(uuid),
    public.read_auction_ban_reviews(),public.review_banned_auction(uuid,text,text) to authenticated;

-- Reconcile restrictions already present when this migration is applied.
select khub_bot.review_restricted_auctions();
notify pgrst,'reload schema';
commit;
