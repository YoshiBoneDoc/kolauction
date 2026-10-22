-- Apply after 077, before deploying the admin bid-reference display.
-- No bot rebuild is required. Does not send mail or change auction deadlines,
-- bid amounts, balances, delivery states, saved messages or settlement rules.
begin;
select pg_advisory_xact_lock(3888760);

create table khub_bot.bid_receipts (
    bid_id uuid primary key references public.bids(id) on delete cascade,
    receipt_id text not null unique references khub_bot.receipts(mail_id) on delete cascade
);
alter table khub_bot.bid_receipts enable row level security;
revoke all on khub_bot.bid_receipts from public,anon,authenticated,service_role;

-- Historical links require the accepted normalized command, exact auction,
-- linked sender and the accepted amount (including buyout caps). Ambiguous
-- matches are left unlinked; timestamps are never used to guess a relationship.
with candidates as (
    select b.id bid_id,r.mail_id receipt_id,
        count(*) over(partition by b.id) bid_matches,
        count(*) over(partition by r.mail_id) receipt_matches
    from public.bids b
    join public.auctions a on a.id=b.auction_id and a.escrow_mode
    join public.profiles p on p.id=b.bidder_id
    join khub_bot.receipts r on r.sender_id=p.kol_player_id and r.result='accepted'
        and r.payload#>>'{command,type}' in ('bid','buy')
        and r.payload->'items'='[]'::jsonb
        and case when (r.payload->'command') ? 'auction_number'
            then r.payload#>>'{command,auction_number}'=a.auction_number::text
            else lower(r.payload#>>'{command,auction_id}')=a.id::text end
        and case when r.payload->>'meat' ~ '^[0-9]{1,19}$' then
            b.amount=least((r.payload->>'meat')::numeric,coalesce(a.instant_purchase_price,(r.payload->>'meat')::numeric))
            else false end
)
insert into khub_bot.bid_receipts(bid_id,receipt_id)
    select bid_id,receipt_id from candidates where bid_matches=1 and receipt_matches=1;

-- Future accepted bids and their receipt link are written in the same transaction.
-- Preserve the existing validation, retry deduplication and financial queue code.
do $$
declare definition text;
    anchor text := 'insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(aid,u.id,u.khub_username,accepted);';
begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected funded bid writer; migration not applied.'; end if;
    execute replace(definition,anchor,
        'with inserted_bid as (insert into public.bids(auction_id,bidder_id,bidder_username,amount) values(aid,u.id,u.khub_username,accepted) returning id) '
        ||'insert into khub_bot.bid_receipts(bid_id,receipt_id) select id,mid from inserted_bid;');
end; $$;

create function khub_bot.admin_bid_delivery_references(p_bid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then return '[]'::jsonb; end if;
    with linked as (
        select b.*,r.mail_id,r.sender_id,
            (select n.id from public.bids n where n.auction_id=b.auction_id and n.amount>b.amount order by n.amount,n.id limit 1) next_bid
        from public.bids b join khub_bot.bid_receipts br on br.bid_id=b.id
            join khub_bot.receipts r on r.mail_id=br.receipt_id where b.id=p_bid
    ), matches as (
        select d.reference_number,d.state,
            case when d.dedupe_key='bid-accepted:'||b.mail_id||':notice' then 'Accepted'
                when d.receipt_id=b.mail_id and d.dedupe_key like 'excess:'||b.mail_id||':meat:%' then 'Excess refund'
                when d.kind='sale_item' then 'Winnings' else 'Bid refund' end label
        from linked b join public.auctions a on a.id=b.auction_id
            left join khub_bot.bid_receipts next_link on next_link.bid_id=b.next_bid
            join khub_bot.deliveries d on d.auction_id=b.auction_id and d.recipient_id=b.sender_id
        where (d.receipt_id=b.mail_id and d.dedupe_key='bid-accepted:'||b.mail_id||':notice')
            or (d.receipt_id=b.mail_id and d.dedupe_key like 'excess:'||b.mail_id||':meat:%')
            or (d.receipt_id=next_link.receipt_id and d.dedupe_key like 'outbid:'||next_link.receipt_id||':meat:%')
            or (b.next_bid is null and a.winner_id=b.bidder_id and a.final_price=b.amount and d.kind='sale_item')
    )
    select coalesce(jsonb_agg(jsonb_build_object('reference','D-'||reference_number,'label',label,'state',state)
        order by reference_number),'[]'::jsonb) into result from matches;
    return result;
end; $$;
revoke all on function khub_bot.admin_bid_delivery_references(uuid) from public,anon,authenticated,service_role;

-- Add the field only for database-verified administrators on detail reads.
-- Direct bids and unverified historical links return no references.
do $$
declare signature regprocedure; definition text;
    anchor text := '''id'',b.id,''auction_id'',b.auction_id,''amount'',b.amount,''created_at'',b.created_at,';
begin
    foreach signature in array array[
        'public.read_auction_page(text,uuid,text,text,text,integer)'::regprocedure,
        'public.read_auction_page(text,uuid,text,text,text,integer,text)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(signature);
        if strpos(definition,anchor)=0 then raise exception 'Unexpected auction bid projection; migration not applied.'; end if;
        -- jsonb concatenation ensures the private key is absent for other viewers.
        definition:=replace(definition,'jsonb_build_object('||E'\n        '||anchor,
            '(case when p_view=''detail'' and khub_bot.is_administrator(auth.uid()) then '
            ||'jsonb_build_object(''admin_delivery_references'',khub_bot.admin_bid_delivery_references(b.id)) '
            ||'else ''{}''::jsonb end)||jsonb_build_object('||E'\n        '||anchor);
        if strpos(definition,'admin_delivery_references')=0 then raise exception 'Unexpected bid JSON layout; migration not applied.'; end if;
        execute definition;
    end loop;
end; $$;
notify pgrst,'reload schema';
commit;
