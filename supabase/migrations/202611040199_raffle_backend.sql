-- Requires 197/198 and existing bot financial migrations. Activation intentionally disabled.
begin;
create table khub_bot.raffle_gate(id boolean primary key default true check(id), enabled boolean not null default false check(not enabled));
insert into khub_bot.raffle_gate values(true,false);
alter table public.mystery_raffles drop constraint mystery_raffles_state_check;
alter table public.mystery_raffles add check(state in ('preview','active','drawing','fulfilling','returning','settled','cancelled','empty'));
alter table public.mystery_raffles add column winner_player_id bigint, add column selected_outcome integer;
grant select(winner_player_id,selected_outcome) on public.mystery_raffles to anon,authenticated;
create table khub_bot.raffle_accounts(
 raffle_id uuid primary key references public.mystery_raffles(id), admin_player_id bigint not null check(admin_player_id>0),
 last_work_at timestamptz not null default 'epoch', held_meat bigint not null default 0 check(held_meat>=0), revenue bigint not null default 0,
 contributions bigint not null default 0, mall_expenses bigint not null default 0,
 ticket_count bigint not null default 0 check(ticket_count>=0), draw_input jsonb, draw_result jsonb,
 prize_queued boolean not null default false, settlement_queued boolean not null default false);
create table khub_bot.raffle_purchases(
 receipt_id text primary key references khub_bot.receipts(mail_id), raffle_id uuid not null references khub_bot.raffle_accounts,
 player_id bigint not null, meat bigint not null check(meat>0), first_ticket bigint not null, last_ticket bigint not null,
 received_at timestamptz not null, check(first_ticket>0 and last_ticket>=first_ticket));
create table khub_bot.raffle_inventory(
 raffle_id uuid not null references khub_bot.raffle_accounts, item_id integer not null,
 quantity bigint not null check(quantity>=0), primary key(raffle_id,item_id));
create table khub_bot.raffle_deposits(
 receipt_id text primary key references khub_bot.receipts(mail_id), raffle_id uuid not null references khub_bot.raffle_accounts,
 items jsonb not null, meat bigint not null, received_at timestamptz not null);
create index raffle_purchase_owner_idx on khub_bot.raffle_purchases(raffle_id,player_id);
create index raffle_due_idx on public.mystery_raffles(ends_at) where state in ('active','drawing');
-- No direct browser access to financial records or draw audits.
alter table khub_bot.raffle_gate enable row level security;
alter table khub_bot.raffle_accounts enable row level security;
alter table khub_bot.raffle_purchases enable row level security;
alter table khub_bot.raffle_inventory enable row level security;
alter table khub_bot.raffle_deposits enable row level security;
revoke all on khub_bot.raffle_gate,khub_bot.raffle_accounts,khub_bot.raffle_purchases,khub_bot.raffle_inventory,khub_bot.raffle_deposits from public,anon,authenticated;
create function public.activate_mystery_raffle(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 if not (select enabled from khub_bot.raffle_gate where id) then raise exception 'Raffles remain preview-only pending lifecycle verification and Mall support'; end if;
 perform pg_advisory_xact_lock(3888760);
 insert into khub_bot.raffle_accounts(raffle_id,admin_player_id)
 select r.id,p.kol_player_id from public.mystery_raffles r join public.profiles p on p.id=r.creator_id
 where r.id=p_id and r.state='preview' and r.ends_at>clock_timestamp() and p.kol_player_id is not null;
 if not found then raise exception 'Raffle cannot activate'; end if;
 update public.mystery_raffles set state='active' where id=p_id;
end $$;
create function public.read_my_raffle_tickets(p_id uuid) returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('ticket_count',coalesce(sum(last_ticket-first_ticket+1),0)::text,
 'purchases',coalesce(jsonb_agg(jsonb_build_object('receipt_id',receipt_id,'meat',meat::text,'first_ticket',first_ticket::text,'last_ticket',last_ticket::text,'received_at',received_at) order by received_at,receipt_id),'[]'))
 from khub_bot.raffle_purchases where raffle_id=p_id and player_id=(select kol_player_id from public.profiles where id=auth.uid());
$$;
alter function public.bot_liabilities() rename to liabilities_before_raffles;
alter function public.liabilities_before_raffles() set schema khub_bot;
revoke all on function khub_bot.liabilities_before_raffles() from public,anon,authenticated,service_role;
create function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
 with b as(select khub_bot.liabilities_before_raffles() v), items as(
 select key,value::numeric n from b,jsonb_each_text(v->'items') union all
 select item_id::text,quantity::numeric from khub_bot.raffle_inventory), totals as(select key,sum(n) n from items group by key)
 select jsonb_build_object('meat',((v->>'meat')::numeric+coalesce((select sum(held_meat) from khub_bot.raffle_accounts),0))::text,
 'items',coalesce((select jsonb_object_agg(key,n::text) from totals),'{}')) from b;
$$;
alter function public.bot_ingest_mail(jsonb) rename to ingest_before_raffles;
alter function public.ingest_before_raffles(jsonb) set schema khub_bot;
revoke all on function khub_bot.ingest_before_raffles(jsonb) from public,anon,authenticated,service_role;
create function public.bot_ingest_mail(p_mail jsonb) returns text language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; sid bigint:=(p_mail->>'sender_id')::bigint;
 rid uuid; r public.mystery_raffles; a khub_bot.raffle_accounts; old khub_bot.receipts;
 m bigint:=(p_mail->>'meat')::bigint; n bigint; x jsonb; valid boolean:=false; outcome_result text;
begin
 if p_mail#>>'{command,type}' not in ('raffle','raffle_supply','raffle_purchase') then return khub_bot.ingest_before_raffles(p_mail); end if;
 perform pg_advisory_xact_lock(3888760);
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
 and not a.prize_queued and not exists(select 1 from jsonb_array_elements(p_mail->'items') i where
 not exists(select 1 from public.mystery_raffle_prizes p where p.raffle_id=rid and p.item_id=(i->>'id')::integer)) then
  for x in select value from jsonb_array_elements(p_mail->'items') loop
   if (x->>'quantity')::bigint<=0 then raise exception 'Invalid deposit'; end if;
   insert into khub_bot.raffle_inventory values(rid,(x->>'id')::integer,(x->>'quantity')::bigint)
   on conflict(raffle_id,item_id) do update set quantity=khub_bot.raffle_inventory.quantity+excluded.quantity;
  end loop;
  insert into khub_bot.raffle_deposits values(mid,rid,p_mail->'items',m,(p_mail->>'received_at')::timestamptz);
  update khub_bot.raffle_accounts set held_meat=held_meat+m,contributions=contributions+m where raffle_id=rid;
  perform khub_bot.queue('raffle-confirm:'||mid,null,mid,sid,'notice',0,'[]','Raffle supply recorded. Items and Meat remain reserved for this raffle.');
  valid:=true;outcome_result:='raffle_supply';
 end if;
 if not valid then
  outcome_result:='raffle_refund';
  perform khub_bot.queue('raffle-refund:'||mid,null,mid,sid,'refund',m,p_mail->'items',
  'Raffle request not accepted; attachments returned. Raffles may be preview-only or closed. Tickets require an exact positive multiple of the ticket price. PURCHASE is disabled until verified Mall support is available; no purchase attempted.');
 end if;
 update khub_bot.receipts set result=outcome_result where mail_id=mid;
 return outcome_result;
end $$;
-- Freeze input under the financial lock. A restart receives exactly the same input.
create function public.bot_raffle_draw_work() returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; input jsonb;
begin
 if not exists(select 1 from public.mystery_raffles where state='drawing' or state='active' and ends_at<=clock_timestamp()) then return '[]'; end if;
 perform pg_advisory_xact_lock(3888760);
 for r in select * from public.mystery_raffles where state='active' and ends_at<=clock_timestamp() order by ends_at limit 5 for update loop
  select jsonb_build_object('raffleId',r.id,'purchases',coalesce((select jsonb_agg(jsonb_build_object('receiptId',receipt_id,'playerId',player_id::text,'ticketCount',(last_ticket-first_ticket+1)::text) order by first_ticket) from khub_bot.raffle_purchases where raffle_id=r.id),'[]'),
  'prizes',(select jsonb_agg(jsonb_build_object('outcome',outcome::text,'itemId',item_id::text,'quantity',quantity::text,'probabilityBps',probability_bps::text) order by outcome) from public.mystery_raffle_prizes where raffle_id=r.id)) into input;
  update khub_bot.raffle_accounts set draw_input=input where raffle_id=r.id;
  update public.mystery_raffles set state=case when jsonb_array_length(input->'purchases')=0 then 'empty' else 'drawing' end where id=r.id;
 end loop;
 return coalesce((select jsonb_agg(a.draw_input) from (select id from public.mystery_raffles where state='drawing' order by ends_at limit 5) pending join khub_bot.raffle_accounts a on a.raffle_id=pending.id),'[]');
end $$;
create function public.bot_commit_raffle_draw(p_id uuid,p_result jsonb) returns void language plpgsql security definer set search_path='' as $$
declare a khub_bot.raffle_accounts; r public.mystery_raffles; t bigint; winner bigint; outcome integer; idx integer;
begin
 perform pg_advisory_xact_lock(3888760);
 select * into r from public.mystery_raffles where id=p_id for update;
 select * into a from khub_bot.raffle_accounts where raffle_id=p_id for update;
 if a.draw_result is not null then return; end if;
 if r.state<>'drawing' or a.draw_input is null or p_result->>'method'<>'crypto-rejection-ticket-then-prize-v1'
 or p_result#>>'{snapshot,raffleId}'<>p_id::text
 or p_result#>'{snapshot,prizes}'<>a.draw_input->'prizes' then raise exception 'Invalid draw'; end if;
 t:=(p_result->>'winningTicket')::bigint; idx:=(p_result->>'prizeIndex')::integer;
 if idx not between 0 and 9999 then raise exception 'Invalid prize index'; end if;
 select player_id into winner from khub_bot.raffle_purchases where raffle_id=p_id and t between first_ticket and last_ticket;
 select (p->>'outcome')::integer into outcome from (
 select p,sum((p->>'probabilityBps')::integer) over(order by ord) endpoint
 from jsonb_array_elements(a.draw_input->'prizes') with ordinality x(p,ord)) q where endpoint>idx order by endpoint limit 1;
 if winner is null or winner::text is distinct from p_result->>'winnerPlayerId' or outcome::text is distinct from p_result->>'selectedOutcome' then raise exception 'Invalid draw selection'; end if;
 update khub_bot.raffle_accounts set draw_result=p_result where raffle_id=p_id;
 update public.mystery_raffles set state='fulfilling',winner_player_id=winner,selected_outcome=outcome where id=p_id;
end $$;
create function public.cancel_mystery_raffle(p_id uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 perform pg_advisory_xact_lock(3888760);
 update public.mystery_raffles set state='cancelled' where id=p_id and state in ('preview','active');
 if not found then raise exception 'Only preview or active raffles can be cancelled'; end if;
end $$;
-- Transfer ownership of obligations from raffle reserves to the existing delivery queue
-- in the same transaction. Only queue verified-delivery-dependent settlement once.
create function public.bot_raffle_tick() returns void language plpgsql security definer set search_path='' as $$
declare r record; a khub_bot.raffle_accounts; prize record; q bigint; x record; prefix text; complete boolean;
begin
 if not exists(select 1 from public.mystery_raffles where state in ('fulfilling','empty','cancelled','returning')) then return; end if;
 perform pg_advisory_xact_lock(3888760);
 for r in select mr.* from public.mystery_raffles mr join khub_bot.raffle_accounts ra on ra.raffle_id=mr.id where mr.state in ('fulfilling','empty','cancelled','returning') order by ra.last_work_at,mr.ends_at limit 10 for update of mr loop
  update khub_bot.raffle_accounts set last_work_at=clock_timestamp() where raffle_id=r.id;
  select * into a from khub_bot.raffle_accounts where raffle_id=r.id for update;
  if not found then continue; end if;
  prefix:='raffle:'||r.id;
  if r.state='fulfilling' and not a.prize_queued then
   select * into prize from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome;
   select quantity into q from khub_bot.raffle_inventory where raffle_id=r.id and item_id=prize.item_id;
   if coalesce(q,0)>=prize.quantity then
    perform khub_bot.queue(prefix||':prize',null,null,r.winner_player_id,'sale_item',0,jsonb_build_array(jsonb_build_object('id',prize.item_id,'quantity',prize.quantity)),'Your kHub raffle prize: '||r.name);
    update khub_bot.raffle_inventory set quantity=quantity-prize.quantity where raffle_id=r.id and item_id=prize.item_id;
    update khub_bot.raffle_accounts set prize_queued=true where raffle_id=r.id;
   else
    perform khub_bot.queue(prefix||':admin',null,null,a.admin_player_id,'notice',0,'[]','Raffle '||r.id||' needs '||(prize.quantity-coalesce(q,0))||' of item #'||prize.item_id||'. KMail SUPPLY '||r.id||' with the missing items. PURCHASE '||r.id||' is unavailable pending verified Mall support; supply the items directly. Delivery target: 30 minutes after closing.');
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
   perform khub_bot.queue(prefix||':contribution',null,null,a.admin_player_id,'refund',a.contributions,'[]','Unused raffle Meat contribution returned.');
   update khub_bot.raffle_inventory set quantity=0 where raffle_id=r.id;
   update khub_bot.raffle_accounts set held_meat=case when r.state in ('cancelled','empty') then 0 else revenue-mall_expenses end,settlement_queued=true where raffle_id=r.id;
   update public.mystery_raffles set state='returning' where id=r.id;
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
revoke all on function public.activate_mystery_raffle(uuid),public.cancel_mystery_raffle(uuid),public.read_my_raffle_tickets(uuid),public.bot_raffle_draw_work(),public.bot_commit_raffle_draw(uuid,jsonb),public.bot_raffle_tick(),public.bot_ingest_mail(jsonb),public.bot_liabilities() from public,anon,authenticated;
grant execute on function public.activate_mystery_raffle(uuid),public.cancel_mystery_raffle(uuid),public.read_my_raffle_tickets(uuid) to authenticated;
grant execute on function public.bot_raffle_draw_work(),public.bot_commit_raffle_draw(uuid,jsonb),public.bot_raffle_tick(),public.bot_ingest_mail(jsonb),public.bot_liabilities() to service_role;
alter function public.bot_worker_status() rename to worker_status_before_raffles;
alter function public.worker_status_before_raffles() set schema khub_bot;
revoke all on function khub_bot.worker_status_before_raffles() from public,anon,authenticated,service_role;
create function public.bot_worker_status() returns jsonb language sql security definer set search_path='' as $$
 select khub_bot.worker_status_before_raffles()||jsonb_build_object('raffleBackendVersion',1);
$$;
revoke all on function public.bot_worker_status() from public,anon,authenticated;
grant execute on function public.bot_worker_status() to service_role;
commit;
