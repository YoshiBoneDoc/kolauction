-- After 244, with the sole connected worker stopped. No historical frozen,
-- sent or uncertain messages, queue rows or asset amounts are rewritten.
begin;
select pg_advisory_xact_lock(3888760);
create function khub_bot.mr_a_asset_label(p_meat bigint,p_quantity bigint) returns text
language sql immutable set search_path='' as $$
 select case when p_quantity>0 then khub_bot.format_message_number(p_quantity)||' Mr. A'||case when p_quantity=1 then '' else 's' end else '' end
 ||case when p_meat>0 or p_quantity=0 then case when p_quantity>0 then ' + ' else '' end||khub_bot.format_message_number(p_meat)||' Meat' else '' end;
$$;
create function khub_bot.mr_a_sale_body(p_id uuid) returns text
language sql stable set search_path='' as $$
 select 'Auction #'||a.auction_number||E' sold!\n\nWinning bid: '
 ||khub_bot.mr_a_asset_label(a.payment_meat,a.payment_mr_a)
 ||E'\nTotal bid value: '||khub_bot.format_message_number(coalesce(a.final_price,a.current_bid))||' Meat'
 ||E'\n\nCommission: '||khub_bot.format_message_number(a.fee_meat)||' Meat'
 ||E'\nYour proceeds: '||khub_bot.mr_a_asset_label(a.payment_meat-a.fee_meat,a.payment_mr_a)
 from public.auctions a where a.id=p_id;
$$;
-- Keep other mixed notices intact. Only future formatter calls change.
do $patch$
declare d text; start_at integer; end_at integer; anchor text;
begin
 d:=pg_get_functiondef('khub_bot.friendly_message(khub_bot.deliveries)'::regprocedure);
 start_at:=strpos(d,' if d.kind=''sale_meat'' then');
 end_at:=strpos(d,' elsif d.dedupe_key like ''bid-accepted:%'' then');
 if start_at=0 or end_at<=start_at then raise exception 'Unexpected mixed payout formatter'; end if;
 anchor:=substring(d from start_at for end_at-start_at);
 execute replace(d,anchor,$body$
 if d.kind='sale_meat' then
   return khub_bot.mr_a_sale_body(a.id)||E'\n\nAttached: '
    ||khub_bot.mr_a_asset_label(d.meat,case when d.item_id=194 then d.quantity else 0 end)
    ||case when d.meat<a.payment_meat-a.fee_meat or (case when d.item_id=194 then d.quantity else 0 end)<a.payment_mr_a
      then E'\nRemaining proceeds will arrive separately.' else '' end;
$body$);
end $patch$;
-- Normalize only recognized, newly formatted mixed payouts. Old frozen text
-- remains individual, just as in existing multi-mail safeguards.
alter function khub_bot.multi_mail_body(khub_bot.deliveries) rename to multi_body_before_mr_a_payout;
create function khub_bot.multi_mail_body(d khub_bot.deliveries) returns text
language plpgsql stable set search_path='' as $$
begin
 if d.kind='sale_meat' and strpos(d.message,'[MrA payment]')>0
   and (d.display_message is null or d.display_message=khub_bot.friendly_message(d)) then
   return khub_bot.mr_a_sale_body(d.auction_id);
 end if;
 return khub_bot.multi_body_before_mr_a_payout(d);
end $$;
do $patch$
declare d text; anchor text;
begin
 d:=pg_get_functiondef('public.bot_claim_delivery_batch(integer)'::regprocedure);
 anchor:='d.kind not in (''refund'',''return_item'',''sale_item'')';
 if strpos(d,anchor)=0 then raise exception 'Unexpected guarded multi-mail claim'; end if;
 execute replace(d,anchor,'(d.kind not in (''refund'',''return_item'',''sale_item'') and not (d.kind=''sale_meat'' and strpos(d.message,''[MrA payment]'')>0))');
 d:=pg_get_functiondef('khub_bot.freeze_batch_attachment_list()'::regprocedure);
 anchor:='new.mail_batch_body:=new.mail_batch_body||E''\n\nThis message contains:\n''||lines;';
 if strpos(d,anchor)=0 then raise exception 'Unexpected batch attachment formatter'; end if;
 execute replace(d,anchor,$body$
 if new.kind='sale_meat' and strpos(new.message,'[MrA payment]')>0
   and new.mail_batch_body=khub_bot.mr_a_sale_body(new.auction_id) then
   new.mail_batch_body:=new.mail_batch_body||E'\n\nAttached: '||(
     select khub_bot.mr_a_asset_label(sum(x.meat)::bigint,coalesce(sum(x.quantity) filter(where x.item_id=194),0)::bigint)
     ||case when sum(x.meat)<a.payment_meat-a.fee_meat or coalesce(sum(x.quantity) filter(where x.item_id=194),0)<a.payment_mr_a
       then E'\nRemaining proceeds will arrive separately.' else '' end
     from khub_bot.deliveries x join public.auctions a on a.id=x.auction_id
     where x.mail_batch=new.id or x.id=new.id group by a.payment_meat,a.fee_meat,a.payment_mr_a);
 else
   new.mail_batch_body:=new.mail_batch_body||E'\n\nThis message contains:\n'||lines;
 end if;
$body$);
end $patch$;
revoke all on function khub_bot.mr_a_asset_label(bigint,bigint),khub_bot.mr_a_sale_body(uuid),khub_bot.multi_body_before_mr_a_payout(khub_bot.deliveries),khub_bot.multi_mail_body(khub_bot.deliveries) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
