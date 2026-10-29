-- Apply with workers stopped after 141. No financial obligation is forgiven,
-- retried or marked complete. This adds read-only source lookups and records an
-- expected untracked-opened-gift review without an exception every worker cycle.
begin;
create index if not exists closet_transfers_receipt_idx on khub_bot.closet_transfers(receipt_id);

create function khub_bot.closet_transfer_details(c khub_bot.closet_transfers) returns jsonb
language sql stable set search_path='' as $$
    select to_jsonb(c)||jsonb_build_object('closet_reference','C-'||c.reference_number,
        'source_player_id',coalesce(r.sender_id,a.seller_kol_id),
        'source_player_name',coalesce(r.payload->>'sender_name',r.payload#>>'{raw,fromname}',p.khub_username),
        'auction_number',a.auction_number,'auction_item',a.item)
    from (select 1) x left join khub_bot.receipts r on r.mail_id=c.receipt_id
        left join public.auctions a on a.id=c.auction_id
        left join public.profiles p on p.id=a.seller_id;
$$;
alter function public.bot_lookup_closet_transfer(text) set schema khub_bot;
alter function khub_bot.bot_lookup_closet_transfer(text) rename to lookup_closet_before_source_details;
create function public.bot_lookup_closet_transfer(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare found_row jsonb; c khub_bot.closet_transfers%rowtype;
begin
    found_row:=khub_bot.lookup_closet_before_source_details(p_reference);
    select * into strict c from khub_bot.closet_transfers where id=(found_row->>'id')::uuid;
    return khub_bot.closet_transfer_details(c);
end;$$;

alter function public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb) set schema khub_bot;
alter function khub_bot.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb) rename to claim_closet_before_source_details;
create function public.bot_claim_closet_transfer(p_snapshot jsonb,p_reserve bigint,p_review_meat bigint,p_review_items jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare found_row jsonb;c khub_bot.closet_transfers%rowtype;
begin
    found_row:=khub_bot.claim_closet_before_source_details(p_snapshot,p_reserve,p_review_meat,p_review_items);
    if found_row is null then return null;end if;
    select * into strict c from khub_bot.closet_transfers where id=(found_row->>'id')::uuid;
    return found_row||khub_bot.closet_transfer_details(c);
end;$$;

create function public.bot_income_status(p_reference text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare mid text; r khub_bot.receipts%rowtype;
begin
    if coalesce(upper(btrim(p_reference)),'') !~ '^M-[1-9][0-9]{0,18}$' then raise exception 'Use a received mail reference such as M-206249968.';end if;
    mid:=substring(upper(btrim(p_reference)) from 3);
    select * into r from khub_bot.receipts where mail_id=mid;
    if not found then return jsonb_build_object('reference','M-'||mid,'found',false);end if;
    return jsonb_build_object('reference','M-'||mid,'found',true,'sender_id',r.sender_id,
        'sender_name',coalesce(r.payload->>'sender_name',r.payload#>>'{raw,fromname}'),
        'received_at',r.received_at,'result',r.result,'received_meat',r.payload->>'meat',
        'received_items',coalesce(r.payload->'items','[]'::jsonb),
        'transfer_count',(select count(*) from khub_bot.closet_transfers where receipt_id=mid),
        'transfers',coalesce((select jsonb_agg(khub_bot.closet_transfer_details(c) order by c.reference_number)
            from (select * from khub_bot.closet_transfers where receipt_id=mid order by reference_number limit 100) c),'[]'::jsonb),
        'blocked_by',coalesce((select jsonb_agg(x.ref order by x.ref) from (
            select distinct 'C-'||u.reference_number ref from khub_bot.closet_transfers u
            where u.state in ('moving','unknown') and exists(select 1 from khub_bot.closet_transfers w
                where w.receipt_id=mid and w.state='pending' and w.item_id is not distinct from u.item_id)
            order by ref limit 20) x),'[]'::jsonb));
end;$$;

alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_income_source_details;
create function public.bot_inspect() returns jsonb language sql security definer set search_path='' as $$
    select khub_bot.inspect_before_income_source_details()||jsonb_build_object('closetAttention',
        coalesce((select jsonb_agg(khub_bot.closet_transfer_details(c) order by c.created_at,c.id)
            from khub_bot.closet_transfers c where c.state in ('moving','unknown')),'[]'::jsonb));
$$;

-- Retained, unchanged gifts already awaiting review should not generate another
-- exception/update on each pass. Changed raw mail still needs a fresh review.
do $$ declare definition text; anchor text:=$a$raise exception 'Previously opened, untracked gift needs manual review.';$a$;
begin
    definition:=pg_get_functiondef('public.bot_register_gift_mail(jsonb)'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected gift registration; inspect before applying 142.';end if;
    execute replace(definition,anchor,$patch$perform public.bot_review_gift_mail(e->'raw',
        'This gift was already open when found, with no verified opening record. Its contents need review; no new deposit or opening is authorized.');
            continue;$patch$);
end;$$;
create or replace function public.bot_review_gift_mail(p_raw jsonb,p_evidence text)
returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if coalesce(p_raw->>'id','') !~ '^[1-9][0-9]*$' or coalesce(p_raw->>'type','')<>'giftshop'
        or length(btrim(coalesce(p_evidence,'')))<12 then raise exception 'Invalid review mail.';end if;
    if exists(select 1 from khub_bot.gift_mail_reviews r where r.mail_id=p_raw->>'id' and r.raw=p_raw
        and (r.resolved_at is not null or r.evidence=p_evidence)) then return;end if;
    if not khub_bot.gift_review_active() then update khub_bot.gift_asset_protection set safe_operating_meat=0 where id;end if;
    insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence) values(p_raw->>'id',p_raw,p_evidence)
        on conflict(mail_id) do update set raw=excluded.raw,evidence=excluded.evidence,resolved_at=null,resolution=null;
end;$$;
revoke all on function khub_bot.closet_transfer_details(khub_bot.closet_transfers),khub_bot.lookup_closet_before_source_details(text),
    khub_bot.inspect_before_income_source_details(),khub_bot.claim_closet_before_source_details(jsonb,bigint,bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.bot_income_status(text),public.bot_lookup_closet_transfer(text),public.bot_inspect(),public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.bot_income_status(text),public.bot_lookup_closet_transfer(text),public.bot_inspect(),public.bot_claim_closet_transfer(jsonb,bigint,bigint,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
