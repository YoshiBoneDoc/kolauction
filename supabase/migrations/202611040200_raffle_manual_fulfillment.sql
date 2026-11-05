-- Apply after 199. No Mall purchasing. Activation remains disabled.
begin;
alter table public.mystery_raffles add column completion_reason text check(completion_reason in ('cancelled','no_tickets','prize_delivered'));
grant select(completion_reason) on public.mystery_raffles to anon,authenticated;
-- Fail if a prior experimental runtime recorded expenses; reconcile before upgrading.
do $$ begin if exists(select 1 from khub_bot.raffle_accounts where mall_expenses<>0) then
 raise exception 'Reconcile historical raffle expenses before applying 200'; end if; end $$;
alter table khub_bot.raffle_accounts drop column mall_expenses;
-- Never discard a legacy obligation or historical contribution silently.
do $$ begin if exists(select 1 from khub_bot.raffle_accounts where contributions<>0)
 or exists(select 1 from khub_bot.raffle_deposits where meat<>0) then
 raise exception 'Legacy raffle contributions require reconciliation before this upgrade'; end if; end $$;
alter table khub_bot.raffle_accounts drop column contributions;
alter table khub_bot.raffle_deposits drop column meat;
alter table khub_bot.raffle_accounts add column advanced_meat bigint not null default 0 check(advanced_meat>=0);
alter table khub_bot.raffle_accounts add check(advanced_meat<=revenue);
alter table khub_bot.raffle_accounts add check(revenue>=0);
create table khub_bot.raffle_advances(
 request_id uuid primary key, raffle_id uuid not null references khub_bot.raffle_accounts,
 amount bigint not null check(amount>0), requested_by uuid not null references public.profiles,
 created_at timestamptz not null default clock_timestamp());
alter table khub_bot.raffle_advances enable row level security;
revoke all on khub_bot.raffle_advances from public,anon,authenticated;
-- Raffle messages are already explicit bodies; auction template inference must
-- never hold these unrelated obligations for an unknown auction template.
create function khub_bot.prepare_raffle_message() returns trigger language plpgsql set search_path='' as $$
begin
 if new.dedupe_key like 'raffle:%' or new.dedupe_key like 'raffle-confirm:%' or new.dedupe_key like 'raffle-refund:%' then
  new.display_message:=coalesce(new.display_message,new.message);
 end if;
 return new;
end $$;
revoke all on function khub_bot.prepare_raffle_message() from public,anon,authenticated,service_role;
create trigger a_prepare_raffle_message before insert on khub_bot.deliveries for each row execute function khub_bot.prepare_raffle_message();
update khub_bot.deliveries set display_message=message where state='pending' and display_message is null and
 (dedupe_key like 'raffle:%' or dedupe_key like 'raffle-confirm:%' or dedupe_key like 'raffle-refund:%');
update khub_bot.delivery_preparation_reviews h set released_at=clock_timestamp(),release_evidence='Raffle explicit message formatter installed by migration 200.'
 where h.released_at is null and exists(select 1 from khub_bot.deliveries d where d.id=h.delivery_id and d.state='pending' and d.display_message is not null and
 (d.dedupe_key like 'raffle:%' or d.dedupe_key like 'raffle-confirm:%' or d.dedupe_key like 'raffle-refund:%'));
-- Shared balance: prior/pending/unknown advances are committed immediately.
create function khub_bot.raffle_available_advance(p_id uuid) returns bigint language sql stable set search_path='' as $$
 select coalesce((select case when r.state='fulfilling' and a.draw_result is not null and not a.settlement_queued
 and not (exists(select 1 from khub_bot.deliveries where dedupe_key like 'raffle:'||p_id||':prize:%')
 and not exists(select 1 from khub_bot.deliveries where dedupe_key like 'raffle:'||p_id||':prize:%' and state<>'sent'))
 then greatest(0,least(a.revenue-a.advanced_meat,a.held_meat)) else 0 end
 from khub_bot.raffle_accounts a join public.mystery_raffles r on r.id=a.raffle_id where r.id=p_id),0);
$$;
revoke all on function khub_bot.raffle_available_advance(uuid) from public,anon,authenticated,service_role;
create function public.request_raffle_advance(p_id uuid,p_request_id uuid,p_amount bigint) returns void
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
 perform khub_bot.queue('raffle:'||p_id||':advance:'||p_request_id,null,null,a.admin_player_id,'sale_meat',p_amount,'[]','Requested raffle proceeds advance. Deducted from final settlement.');
 update khub_bot.raffle_accounts set held_meat=held_meat-p_amount,advanced_meat=advanced_meat+p_amount where raffle_id=p_id;
end $$;
create function public.read_my_raffle_counts(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_object_agg(raffle_id,n::text),'{}') from (
 select raffle_id,sum(last_ticket-first_ticket+1) n from khub_bot.raffle_purchases
 where raffle_id=any(p_ids[1:20]) and player_id=(select kol_player_id from public.profiles where id=auth.uid()) group by raffle_id) counts;
$$;
create function public.read_raffle_management(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare a khub_bot.raffle_accounts; v jsonb;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 select * into a from khub_bot.raffle_accounts where raffle_id=p_id;
 if a.raffle_id is not null and not exists(select 1 from public.profiles where id=auth.uid() and kol_player_id=a.admin_player_id) then raise exception 'Raffle owner required'; end if;
 select jsonb_build_object('state',r.state,'completion_reason',r.completion_reason,'activation_enabled',false,'winner_player_id',r.winner_player_id,
 'prize',(select jsonb_build_object('item_id',item_id,'name',name,'quantity',quantity::text) from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome),
 'revenue',coalesce(a.revenue,0)::text,
 'advanced_meat',coalesce(a.advanced_meat,0)::text,'held_meat',coalesce(a.held_meat,0)::text,
 'available_advance',khub_bot.raffle_available_advance(p_id)::text,
 'inventory',coalesce((select jsonb_agg(jsonb_build_object('item_id',i.item_id,'name',p.name,'quantity',i.quantity::text)) from khub_bot.raffle_inventory i join public.mystery_raffle_prizes p on p.raffle_id=i.raffle_id and p.item_id=i.item_id where i.raffle_id=r.id),'[]'),
 'deposits',coalesce((select jsonb_agg(jsonb_build_object('receipt_id',receipt_id,'items',items,'received_at',received_at) order by received_at) from khub_bot.raffle_deposits where raffle_id=r.id),'[]'),
 'advances',coalesce((select jsonb_agg(jsonb_build_object('request_id',request_id,'amount',amount::text,'created_at',created_at)) from khub_bot.raffle_advances where raffle_id=r.id),'[]'),
 'deliveries',coalesce((select jsonb_agg(jsonb_build_object('reference',dedupe_key,'state',state,'meat',meat::text,'item_id',item_id,'quantity',quantity::text) order by created_at,id) from khub_bot.deliveries where dedupe_key like 'raffle:'||r.id||':%'),'[]')) into v
 from public.mystery_raffles r where r.id=p_id;
 if v is null then raise exception 'Raffle not found'; end if;
 return v;
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
 rid:=(p_mail#>>'{command,raffle_id}')::uuid;
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
     'Raffle advance: '||to_char(advance_amount,'FM999,999,999,999,999,999,999')||' Meat. Remaining available: '||to_char(available-advance_amount,'FM999,999,999,999,999,999,999')||' Meat. Deducted from final settlement.');
    update khub_bot.raffle_accounts set held_meat=held_meat-advance_amount,advanced_meat=advanced_meat+advance_amount where raffle_id=rid;
    outcome_result:='raffle_advance';
   else
    perform khub_bot.queue('raffle-confirm:advance-rejected:'||mid,null,mid,sid,'refund',m,p_mail->'items',
     'Raffle advance not accepted. Available: '||to_char(available,'FM999,999,999,999,999,999,999')||' Meat. Send ADVANCE '||rid||' <amount> with no attachments. Any attachments are returned.');
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
   'Raffle tickets accepted: '||(a.ticket_count+1)||' through '||(a.ticket_count+n)||'. Each ticket has equal weight. One ticket and then one independent weighted prize are drawn using cryptographic rejection sampling. Your history is private on kHub.');
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
  perform khub_bot.queue('raffle-confirm:'||mid,null,mid,sid,'notice',0,'[]','Raffle prize items received and reserved for this raffle.');
  valid:=true;outcome_result:='raffle_supply';
 end if;
 if not valid then
  outcome_result:='raffle_refund';
  perform khub_bot.queue('raffle-refund:'||mid,null,mid,sid,'refund',m,p_mail->'items',
  case when p_mail#>>'{command,type}'='raffle_supply' and m>0 then 'SUPPLY accepts prize items only; do not attach Meat. Your attachments are returned.' else 'Raffle request not accepted; attachments returned. Raffles may be preview-only or closed. Tickets require an exact positive multiple of the ticket price.' end);
 end if;
 update khub_bot.receipts set result=outcome_result where mail_id=mid;
 return outcome_result;
end $$;
create or replace function public.activate_mystery_raffle(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 if not coalesce((select enabled from khub_bot.raffle_gate where id),false) then raise exception 'Raffles remain preview-only pending lifecycle verification'; end if;
 perform pg_advisory_xact_lock(3888760);
 insert into khub_bot.raffle_accounts(raffle_id,admin_player_id)
 select r.id,p.kol_player_id from public.mystery_raffles r join public.profiles p on p.id=r.creator_id
 where r.id=p_id and r.state='preview' and r.ends_at>clock_timestamp() and p.kol_player_id is not null;
 if not found then raise exception 'Raffle cannot activate'; end if;
 update public.mystery_raffles set state='active' where id=p_id;
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
    'You won '||prize.quantity||' x '||prize.name||' in '||r.name||'. We will send your prize as soon as it is ready. Delivery target: 30 minutes after closing.');
  end if;
  if r.state='fulfilling' and not a.prize_queued then
   select * into prize from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome;
   select quantity into q from khub_bot.raffle_inventory where raffle_id=r.id and item_id=prize.item_id;
   if coalesce(q,0)>=prize.quantity then
    perform khub_bot.queue(prefix||':prize',null,null,r.winner_player_id,'sale_item',0,jsonb_build_array(jsonb_build_object('id',prize.item_id,'quantity',prize.quantity)),'Your kHub raffle prize: '||r.name);
    update khub_bot.raffle_inventory set quantity=quantity-prize.quantity where raffle_id=r.id and item_id=prize.item_id;
    update khub_bot.raffle_accounts set prize_queued=true where raffle_id=r.id;
   else
    perform khub_bot.queue(prefix||':admin',null,null,a.admin_player_id,'notice',0,'[]','Raffle '||r.id||' needs '||(prize.quantity-coalesce(q,0))||' of item #'||prize.item_id||' ('||prize.name||', total selected quantity '||prize.quantity||'). KMail SUPPLY '||r.id||' with the missing items. Available advance: '||to_char(khub_bot.raffle_available_advance(r.id),'FM999,999,999,999,999,999,999')||' Meat. KMail ADVANCE '||r.id||' <amount> with no attachments. Delivery target: 30 minutes after closing.');
   end if;
  end if;
  if r.state='fulfilling' then
   complete:=exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%') and not exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%' and state<>'sent');
   if not complete then
    if clock_timestamp()>=r.ends_at+interval '30 minutes' then
     perform khub_bot.queue(prefix||':delay',null,null,r.winner_player_id,'notice',0,'[]','Your raffle prize delivery is delayed. The administrator has been notified. Delivery has not yet been verified.');
    end if;
    continue;
   end if;
  end if;
  if not a.settlement_queued then
   if r.state='cancelled' then
    for x in select * from khub_bot.raffle_purchases where raffle_id=r.id loop
     perform khub_bot.queue(prefix||':refund:'||x.receipt_id,null,x.receipt_id,x.player_id,'refund',x.meat,'[]','Raffle cancelled; ticket payment returned.');
    end loop;
   end if;
   for x in select * from khub_bot.raffle_inventory where raffle_id=r.id and quantity>0 loop
    perform khub_bot.queue(prefix||':return:'||x.item_id,null,null,a.admin_player_id,'return_item',0,jsonb_build_array(jsonb_build_object('id',x.item_id,'quantity',x.quantity)),'Unused raffle deposit returned.');
   end loop;
   update khub_bot.raffle_inventory set quantity=0 where raffle_id=r.id;
   update khub_bot.raffle_accounts set held_meat=case when r.state in ('cancelled','empty') then 0 else revenue-advanced_meat end,settlement_queued=true where raffle_id=r.id;
   update public.mystery_raffles set state='returning',completion_reason=case when r.state='cancelled' then 'cancelled' when r.state='empty' then 'no_tickets' else 'prize_delivered' end where id=r.id;
  elsif not exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':%' and state not in ('sent','cancelled')) then
   if a.held_meat>0 then
    perform khub_bot.queue(prefix||':proceeds',null,null,a.admin_player_id,'sale_meat',a.held_meat,'[]','Raffle proceeds after verified prize delivery and deposit returns.');
    update khub_bot.raffle_accounts set held_meat=0 where raffle_id=r.id;
   else
    update public.mystery_raffles set state='settled' where id=r.id;
   end if;
  end if;
 end loop;
end $$;
create or replace function public.bot_commit_raffle_draw(p_id uuid,p_result jsonb) returns void language plpgsql security definer set search_path='' as $$
declare a khub_bot.raffle_accounts; r public.mystery_raffles; t bigint; winner bigint; outcome integer; idx integer;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into r from public.mystery_raffles where id=p_id for update;
 select * into a from khub_bot.raffle_accounts where raffle_id=p_id for update;
 if a.draw_result is not null then return; end if;
 if r.state is distinct from 'drawing' or a.draw_input is null or p_result->>'method' is distinct from 'crypto-rejection-ticket-then-prize-v1'
 or p_result#>>'{snapshot,raffleId}' is distinct from p_id::text
 or p_result#>'{snapshot,prizes}' is distinct from a.draw_input->'prizes' then raise exception 'Invalid draw'; end if;
 if p_result#>'{snapshot,ranges}' is distinct from (select jsonb_agg(jsonb_build_object('receiptId',receipt_id,'playerId',player_id::text,'first',first_ticket::text,'last',last_ticket::text) order by first_ticket) from khub_bot.raffle_purchases where raffle_id=p_id)
 or jsonb_typeof(p_result->'ticketSamples') is distinct from 'array' or jsonb_typeof(p_result->'prizeSamples') is distinct from 'array'
 or p_result->>'snapshotSha256' is null then raise exception 'Incomplete draw audit'; end if;
 t:=(p_result->>'winningTicket')::bigint; idx:=(p_result->>'prizeIndex')::integer;
 if idx is null or idx not between 0 and 9999 then raise exception 'Invalid prize index'; end if;
 select player_id into winner from khub_bot.raffle_purchases where raffle_id=p_id and t between first_ticket and last_ticket;
 select (p->>'outcome')::integer into outcome from (
 select p,ord,sum((p->>'probabilityBps')::integer) over(order by ord) endpoint
 from jsonb_array_elements(a.draw_input->'prizes') with ordinality x(p,ord)) q where endpoint>idx order by ord limit 1;
 if winner is null or winner::text is distinct from p_result->>'winnerPlayerId' or outcome::text is distinct from p_result->>'selectedOutcome' then raise exception 'Invalid draw selection'; end if;
 update khub_bot.raffle_accounts set draw_result=p_result where raffle_id=p_id;
 update public.mystery_raffles set state='fulfilling',winner_player_id=winner,selected_outcome=outcome where id=p_id;
end $$;
create or replace function public.read_my_raffle_tickets(p_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('ticket_count',coalesce(sum(last_ticket-first_ticket+1),0)::text,
 'purchases',coalesce(jsonb_agg(jsonb_build_object('receipt_id',p.receipt_id,'meat',p.meat::text,'first_ticket',first_ticket::text,'last_ticket',last_ticket::text,'received_at',p.received_at,
 'refund_status',case when exists(select 1 from khub_bot.deliveries d where d.dedupe_key like 'raffle:'||p.raffle_id||':refund:'||p.receipt_id||':%') then
 case when exists(select 1 from khub_bot.deliveries d where d.dedupe_key like 'raffle:'||p.raffle_id||':refund:'||p.receipt_id||':%' and d.state<>'sent') then 'awaiting_verification' else 'refunded' end else null end) order by p.received_at,p.receipt_id),'[]'))
 from khub_bot.raffle_purchases p where raffle_id=p_id and player_id=(select kol_player_id from public.profiles where id=auth.uid());
$$;
revoke all on function public.request_raffle_advance(uuid,uuid,bigint),public.read_my_raffle_counts(uuid[]),public.read_raffle_management(uuid) from public,anon,authenticated;
grant execute on function public.request_raffle_advance(uuid,uuid,bigint),public.read_my_raffle_counts(uuid[]),public.read_raffle_management(uuid) to authenticated;
-- Existing function replacements preserve 199's service-only execution grants.
-- Runtimes can distinguish the complete manual-fulfillment schema from 199.
create or replace function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select khub_bot.worker_status_before_raffles()||jsonb_build_object('raffleBackendVersion',2);
$$;
revoke all on function public.bot_worker_status() from public,anon,authenticated;
grant execute on function public.bot_worker_status() to service_role;
notify pgrst,'reload schema';
commit;
