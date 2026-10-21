-- Apply after 060. Reuse the private Trade inbox and auction-grouped queries.
-- Escrow sellers can ask about deposits/returns at any stage. Buyers must be
-- finalized winners; leading bidders and unrelated accounts cannot submit.
begin;
create or replace function public.submit_trade_query(p_request_id uuid,p_auction_id uuid,p_body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
    a public.auctions%rowtype; actor public.profiles%rowtype; r khub_bot.bug_reports%rowtype;
    v_body text:=btrim(p_body,E' \t\r\n');
    parts text[]:='{}'; part text:=''; encoded text; message text; delivery uuid; i integer;
begin
    perform khub_bot.require_verified_trader();
    select * into actor from public.profiles where id=auth.uid();
    if actor.id is null or actor.kol_player_id is null or actor.kol_verified_at is null then
        raise exception 'Log in with a verified kHub account to send a trade query.' using errcode='42501';
    end if;
    select * into a from public.auctions where id=p_auction_id;
    if a.id is null or not (case when a.escrow_mode then
        actor.id=a.seller_id or (a.finalized_at is not null and a.winner_id is not null and actor.id=a.winner_id)
        else a.finalized_at is not null and a.winner_id is not null
            and a.status in ('awaiting_trade','completed') and actor.id in (a.seller_id,a.winner_id) end) then
        raise exception 'Only the seller of an Escrow listing, or the seller or winner of a closed sale, can send a trade query.';
    end if;
    if p_request_id is null or v_body is null or char_length(v_body) not between 10 and 2000 then
        raise exception 'Please describe your trade query in 10 to 2,000 characters.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('khub-bug-report:'||actor.id::text,0));
    select * into r from khub_bot.bug_reports where id=p_request_id;
    if found then
        if r.reporter_id is distinct from actor.id or r.body<>v_body or not exists(select 1 from khub_bot.trade_queries q where q.report_id=r.id and q.auction_id=a.id) then
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
            ||E'\nTrading method: '||case when a.escrow_mode then 'Escrow' else 'Direct Trade' end
            ||E'\nItem: '||khub_bot.format_message_number(a.quantity)||' x '||khub_bot.escape_report_kmail(left(a.item,80))
            ||case when a.final_price is not null then E'\nFinal price: '||khub_bot.format_message_number(a.final_price)||' Meat' else '' end
            ||E'\nFrom: '||khub_bot.escape_report_kmail(left(actor.khub_username,60))||' (#'||actor.kol_player_id||')'
            ||E'\n\n'||parts[i]||E'\n\nAdministrator inbox: /admin/inbox?category=trade';
        insert into khub_bot.deliveries(dedupe_key,recipient_id,kind,message,display_message,display_footer)
            values('bug-report:'||r.id||':'||i,3552305,'notice',message,message,'') returning id into delivery;
        insert into khub_bot.bug_report_deliveries(report_id,delivery_id) values(r.id,delivery);
    end loop;
    return jsonb_build_object('reference','B-'||r.report_number,'notification','queued');
end; $$;

notify pgrst,'reload schema';
commit;
