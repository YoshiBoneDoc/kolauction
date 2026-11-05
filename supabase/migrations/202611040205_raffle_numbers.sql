-- Apply after 204. Internal UUIDs, receipt payloads and delivery keys are unchanged.
begin;
lock table public.mystery_raffles in access exclusive mode;
create sequence khub_bot.raffle_number_seq start with 1001;
alter table public.mystery_raffles add column raffle_number bigint;
with numbered as (select id,1000+row_number() over(order by created_at,id) n from public.mystery_raffles)
update public.mystery_raffles r set raffle_number=n.n from numbered n where r.id=n.id;
select setval('khub_bot.raffle_number_seq',greatest(1001,coalesce((select max(raffle_number)+1 from public.mystery_raffles),1001)),false);
alter table public.mystery_raffles alter column raffle_number set not null;
alter table public.mystery_raffles add unique(raffle_number);
alter table public.mystery_raffles add check(raffle_number>=1001);
create function khub_bot.assign_raffle_number() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='INSERT' then new.raffle_number:=nextval('khub_bot.raffle_number_seq');
 elsif new.raffle_number is distinct from old.raffle_number then raise exception 'Raffle number is immutable'; end if;
 return new;
end $$;
revoke all on sequence khub_bot.raffle_number_seq from public,anon,authenticated,service_role;
revoke all on function khub_bot.assign_raffle_number() from public,anon,authenticated,service_role;
create trigger assign_raffle_number before insert or update of raffle_number on public.mystery_raffles for each row execute function khub_bot.assign_raffle_number();
grant select(raffle_number) on public.mystery_raffles to anon,authenticated;
create function khub_bot.resolve_raffle_id(p_ref text) returns uuid language plpgsql stable security definer set search_path='' as $$
begin
 if p_ref ~ '^[1-9][0-9]{0,18}$' then
  return (select id from public.mystery_raffles where raffle_number::numeric=p_ref::numeric);
 elsif p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  return (select id from public.mystery_raffles where id=p_ref::uuid);
 end if;
 return null;
end $$;
revoke all on function khub_bot.resolve_raffle_id(text) from public,anon,authenticated,service_role;
create or replace function public.request_raffle_advance(p_id uuid,p_request_id uuid,p_amount bigint) returns void
language plpgsql security definer set search_path='' as $$
declare a khub_bot.raffle_accounts; old khub_bot.raffle_advances; r public.mystery_raffles;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 perform pg_advisory_xact_lock(3888760);
 select * into r from public.mystery_raffles where id=p_id for update;
 select * into a from khub_bot.raffle_accounts where raffle_id=p_id for update;
 if a.raffle_id is null or not exists(select 1 from public.profiles where id=auth.uid() and kol_player_id=a.admin_player_id) then raise exception 'Raffle owner required'; end if;
 select * into old from khub_bot.raffle_advances where request_id=p_request_id;
 if found then
  if old.raffle_id<>p_id or old.requested_by<>auth.uid() or old.amount is distinct from p_amount then raise exception 'Advance request conflict'; end if;
  return;
 end if;
 if exists(select 1 from khub_bot.deliveries where dedupe_key like 'raffle:'||p_id||':prize:%')
 and not exists(select 1 from khub_bot.deliveries where dedupe_key like 'raffle:'||p_id||':prize:%' and state<>'sent') then
 raise exception 'Prize delivery already verified'; end if;
 if p_request_id is null or p_amount is null or p_amount<=0 or r.state<>'fulfilling' or a.draw_result is null
 or a.settlement_queued or p_amount>khub_bot.raffle_available_advance(p_id) then
 raise exception 'Advance exceeds available proceeds or raffle is not awaiting delivery. Available: % Meat.',khub_bot.raffle_available_advance(p_id); end if;
 insert into khub_bot.raffle_advances(request_id,raffle_id,amount,requested_by) values(p_request_id,p_id,p_amount,auth.uid());
 perform khub_bot.queue('raffle:'||p_id||':advance:'||p_request_id,null,null,a.admin_player_id,'sale_meat',p_amount,'[]','Your '||to_char(p_amount,'FM999,999,999,999,999,999,999')||' Meat advance for '||r.name||' (#'||r.raffle_number||')'||' is attached. This amount comes out of your final payout.');
 update khub_bot.raffle_accounts set held_meat=held_meat-p_amount,advanced_meat=advanced_meat+p_amount where raffle_id=p_id;
end $$;
create or replace function public.bot_ingest_mail(p_mail jsonb) returns text language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
 rid uuid; r public.mystery_raffles; a khub_bot.raffle_accounts; old khub_bot.receipts;
 m bigint:=(p_mail->>'meat')::bigint; n bigint; x jsonb; valid boolean:=false; outcome_result text; available bigint; advance_amount bigint; request uuid; owner_id uuid;
begin
 if p_mail#>>'{command,type}' not in ('raffle','raffle_supply','raffle_advance') then return khub_bot.ingest_before_raffles(p_mail); end if;
 perform pg_advisory_xact_lock(3888760);
 -- Preserve the shared intake proof fence before recording any raffle assets.
 if p_mail->'raw' ? 'gift_original' and not exists(select 1 from khub_bot.incoming_gifts where mail_id=p_mail->>'id' and payload=p_mail and not legacy_donation) then raise exception 'Gift contents have not been verified.'; end if;
 select * into old from khub_bot.receipts where mail_id=mid;
 if found then
  if old.payload<>p_mail then raise exception 'Receipt payload conflict'; end if;
  return 'duplicate';
 end if;
 rid:=khub_bot.resolve_raffle_id(p_mail#>>'{command,raffle_id}');
 select * into r from public.mystery_raffles where id=rid for update;
 select * into a from khub_bot.raffle_accounts where raffle_id=rid for update;
 insert into khub_bot.receipts(mail_id,sender_id,received_at,payload) values(mid,sid,(p_mail->>'received_at')::timestamptz,p_mail);
 if m<0 or jsonb_typeof(p_mail->'items') is distinct from 'array' then raise exception 'Invalid attachments'; end if;
 if a.raffle_id is not null and sid=a.admin_player_id and p_mail#>>'{command,type}'='raffle_advance' then
  select id into owner_id from public.profiles p where p.kol_player_id=sid and khub_bot.is_administrator(p.id);
  if owner_id is not null then
   available:=khub_bot.raffle_available_advance(rid);
   advance_amount:=case when p_mail#>>'{command,amount}' ~ '^[0-9]{1,19}$' and (p_mail#>>'{command,amount}')::numeric<=9223372036854775807 then (p_mail#>>'{command,amount}')::bigint else 0 end;
   if advance_amount>0 and advance_amount<=available and m=0 and jsonb_array_length(p_mail->'items')=0 then
    request:=md5('raffle-advance:'||mid)::uuid;
    insert into khub_bot.raffle_advances(request_id,raffle_id,amount,requested_by) values(request,rid,advance_amount,owner_id);
    perform khub_bot.queue('raffle:'||rid||':advance:'||request,null,mid,sid,'sale_meat',advance_amount,'[]',
     'Your advance for '||r.name||' (#'||r.raffle_number||')'||': '||to_char(advance_amount,'FM999,999,999,999,999,999,999')||' Meat attached. Available for another advance: '||to_char(available-advance_amount,'FM999,999,999,999,999,999,999')||' Meat. This amount comes out of your final payout.');
    update khub_bot.raffle_accounts set held_meat=held_meat-advance_amount,advanced_meat=advanced_meat+advance_amount where raffle_id=rid;
    outcome_result:='raffle_advance';
   else
    perform khub_bot.queue('raffle-confirm:advance-rejected:'||mid,null,mid,sid,'refund',m,p_mail->'items',
     'Advance not accepted for '||r.name||' (#'||r.raffle_number||')'||'. Available: '||to_char(available,'FM999,999,999,999,999,999,999')||' Meat. Send ADVANCE '||r.raffle_number||' <amount> with no attachments. Any attachments are returned.');
    outcome_result:='raffle_advance_rejected';
   end if;
   update khub_bot.receipts set result=outcome_result where mail_id=mid;
   return outcome_result;
  end if;
 end if;
 if a.raffle_id is not null and p_mail#>>'{command,type}'='raffle' and r.state='active'
 and clock_timestamp()<r.ends_at and (p_mail->>'received_at')::timestamptz<r.ends_at
 and jsonb_array_length(p_mail->'items')=0 and m>0 and m%r.ticket_price=0 then
  n:=m/r.ticket_price;
  insert into khub_bot.raffle_purchases values(mid,rid,sid,m,a.ticket_count+1,a.ticket_count+n,(p_mail->>'received_at')::timestamptz);
  update khub_bot.raffle_accounts set ticket_count=ticket_count+n,held_meat=held_meat+m,revenue=revenue+m where raffle_id=rid;
  perform khub_bot.queue('raffle-confirm:'||mid,null,mid,sid,'notice',0,'[]',
   'Thanks for entering '||r.name||' (#'||r.raffle_number||')'||'! You bought '||n||' ticket(s), numbered '||(a.ticket_count+1)||' through '||(a.ticket_count+n)||'. Each ticket has an equal chance of winning. Good luck!');
  valid:=true; outcome_result:='raffle_tickets';
 elsif a.raffle_id is not null and sid=a.admin_player_id
 and exists(select 1 from public.profiles p where p.kol_player_id=sid and khub_bot.is_administrator(p.id)) and p_mail#>>'{command,type}'='raffle_supply'
 and (r.state='active' and clock_timestamp()<r.ends_at or r.state='fulfilling')
 and m=0 and jsonb_array_length(p_mail->'items')>0
 and not a.prize_queued and not exists(select 1 from jsonb_array_elements(p_mail->'items') i where
 not exists(select 1 from public.mystery_raffle_prizes p where p.raffle_id=rid and p.item_id=(i->>'id')::integer)) then
  for x in select value from jsonb_array_elements(p_mail->'items') loop
   if (x->>'quantity')::bigint<=0 then raise exception 'Invalid deposit'; end if;
   insert into khub_bot.raffle_inventory values(rid,(x->>'id')::integer,(x->>'quantity')::bigint)
   on conflict(raffle_id,item_id) do update set quantity=khub_bot.raffle_inventory.quantity+excluded.quantity;
  end loop;
  insert into khub_bot.raffle_deposits(receipt_id,raffle_id,items,received_at) values(mid,rid,p_mail->'items',(p_mail->>'received_at')::timestamptz);
  perform khub_bot.queue('raffle-confirm:'||mid,null,mid,sid,'notice',0,'[]','Thanks! Your prize items for '||r.name||' (#'||r.raffle_number||')'||' have been received and reserved.');
  valid:=true;outcome_result:='raffle_supply';
 end if;
 if not valid then
  outcome_result:='raffle_refund';
  perform khub_bot.queue('raffle-refund:'||mid,null,mid,sid,'refund',m,p_mail->'items',
  case when p_mail#>>'{command,type}'='raffle_supply' and m>0 then 'SUPPLY for '||coalesce(r.name||' (#'||r.raffle_number||')',p_mail#>>'{command,raffle_id}','unknown raffle')||' accepts prize items only; please do not attach Meat. Your attachments are included with this refund.' else 'Your request for '||coalesce(r.name||' (#'||r.raffle_number||')',p_mail#>>'{command,raffle_id}','unknown raffle')||' was not accepted. Any attached Meat or items are included with this refund. The raffle may be preview-only or closed; ticket payments must be an exact multiple of the ticket price.' end);
 end if;
 update khub_bot.receipts set result=outcome_result where mail_id=mid;
 return outcome_result;
end $$;
create or replace function public.bot_raffle_tick() returns void language plpgsql security definer set search_path='' as $$
declare r record; a khub_bot.raffle_accounts; prize record; q bigint; x record; prefix text; complete boolean;
begin
 if not exists(select 1 from public.mystery_raffles where state in ('fulfilling','empty','cancelled','returning')) then return; end if;
 perform pg_advisory_xact_lock(3888760);
 for r in select mr.* from public.mystery_raffles mr join khub_bot.raffle_accounts ra on ra.raffle_id=mr.id where mr.state in ('fulfilling','empty','cancelled','returning') order by ra.last_work_at,mr.ends_at limit 10 for update of mr loop
  update khub_bot.raffle_accounts set last_work_at=clock_timestamp() where raffle_id=r.id;
  select * into a from khub_bot.raffle_accounts where raffle_id=r.id for update;
  if not found then continue; end if;
  prefix:='raffle:'||r.id;
  if r.state='fulfilling' then
   select * into prize from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome;
   perform khub_bot.queue(prefix||':winner',null,null,r.winner_player_id,'notice',0,'[]',
    'Congratulations! You won '||prize.quantity||' x '||prize.name||' in '||r.name||' (#'||r.raffle_number||')'||'! Your prize is being prepared and should arrive within 30 minutes of closing, or sooner.');
  end if;
  if r.state='fulfilling' and not a.prize_queued then
   select * into prize from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome;
   select quantity into q from khub_bot.raffle_inventory where raffle_id=r.id and item_id=prize.item_id;
   if coalesce(q,0)>=prize.quantity then
    perform khub_bot.queue(prefix||':prize',null,null,r.winner_player_id,'sale_item',0,jsonb_build_array(jsonb_build_object('id',prize.item_id,'quantity',prize.quantity)),'Congratulations again on winning '||r.name||' (#'||r.raffle_number||')'||'! Your prize is attached. Thanks for playing!');
    update khub_bot.raffle_inventory set quantity=quantity-prize.quantity where raffle_id=r.id and item_id=prize.item_id;
    update khub_bot.raffle_accounts set prize_queued=true where raffle_id=r.id;
   else
    perform khub_bot.queue(prefix||':admin',null,null,a.admin_player_id,'notice',0,'[]','Prize needed for '||r.name||' (#'||r.raffle_number||')'||': '||(prize.quantity-coalesce(q,0))||' x '||prize.name||' (item #'||prize.item_id||'). KMail SUPPLY '||r.raffle_number||' with the missing items. Available advance: '||to_char(khub_bot.raffle_available_advance(r.id),'FM999,999,999,999,999,999,999')||' Meat. KMail ADVANCE '||r.raffle_number||' <amount> with no attachments. Delivery target: 30 minutes after closing.');
   end if;
  end if;
  if r.state='fulfilling' then
   complete:=exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%') and not exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%' and state<>'sent');
   if not complete then
    if clock_timestamp()>r.ends_at+interval '30 minutes' then
     perform khub_bot.queue(prefix||':delay',null,null,r.winner_player_id,'notice',0,'[]','Your prize from '||r.name||' (#'||r.raffle_number||')'||' is still being prepared. We have passed our 30-minute delivery target, and the administrator has been notified. Thanks for your patience!');
    end if;
    continue;
   end if;
  end if;
  if not a.settlement_queued then
   if r.state='cancelled' then
    for x in select * from khub_bot.raffle_purchases where raffle_id=r.id loop
     perform khub_bot.queue(prefix||':refund:'||x.receipt_id,null,x.receipt_id,x.player_id,'refund',x.meat,'[]',r.name||' (#'||r.raffle_number||')'||' was cancelled. Your '||to_char(x.meat,'FM999,999,999,999,999,999,999')||' Meat ticket payment is attached. Thanks for your understanding.');
    end loop;
   end if;
   for x in select * from khub_bot.raffle_inventory where raffle_id=r.id and quantity>0 loop
    perform khub_bot.queue(prefix||':return:'||x.item_id,null,null,a.admin_player_id,'return_item',0,jsonb_build_array(jsonb_build_object('id',x.item_id,'quantity',x.quantity)),'Your unused prize items from '||r.name||' (#'||r.raffle_number||')'||' are attached. Thanks for hosting!');
   end loop;
   update khub_bot.raffle_inventory set quantity=0 where raffle_id=r.id;
   update khub_bot.raffle_accounts set held_meat=case when r.state in ('cancelled','empty') then 0 else revenue-advanced_meat end,settlement_queued=true where raffle_id=r.id;
   update public.mystery_raffles set state='returning',completion_reason=case when r.state='cancelled' then 'cancelled' when r.state='empty' then 'no_tickets' else 'prize_delivered' end where id=r.id;
  elsif not exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':%' and state not in ('sent','cancelled')) then
   if a.held_meat>0 then
    perform khub_bot.queue(prefix||':proceeds',null,null,a.admin_player_id,'sale_meat',a.held_meat,'[]','Your final payout for '||r.name||' (#'||r.raffle_number||')'||' is attached: '||to_char(a.held_meat,'FM999,999,999,999,999,999,999')||' Meat, after advances. Prize delivery and unused-item returns have been verified. Thanks for hosting!');
    update khub_bot.raffle_accounts set held_meat=0 where raffle_id=r.id;
   else
    update public.mystery_raffles set state='settled' where id=r.id;
   end if;
  end if;
 end loop;
end $$;
do $$ declare source text; begin
 source:=pg_get_functiondef('public.read_raffle_management(uuid)'::regprocedure);
 execute replace(source,'''state'',r.state','''raffle_number'',r.raffle_number::text,''state'',r.state');
end $$;
do $$ declare source text; begin
 source:=pg_get_functiondef('public.read_admin_raffle_analytics(integer)'::regprocedure);
 source:=replace(source,'select r.id,r.name,r.state','select r.id,r.raffle_number::text,r.name,r.state');
 source:=replace(source,'select id,name,state,completion_reason','select id,raffle_number::text,name,state,completion_reason');
 execute source;
end $$;
notify pgrst,'reload schema';
commit;
