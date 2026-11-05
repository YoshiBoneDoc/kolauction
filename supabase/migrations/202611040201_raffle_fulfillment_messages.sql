-- Apply after 200. Notification wording only; financial rules and activation gate unchanged.
begin;
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
    'Congratulations! You won '||prize.quantity||' x '||prize.name||' in '||r.name||'! Your prize is being prepared and should arrive within 30 minutes of closing, or sooner.');
  end if;
  if r.state='fulfilling' and not a.prize_queued then
   select * into prize from public.mystery_raffle_prizes where raffle_id=r.id and outcome=r.selected_outcome;
   select quantity into q from khub_bot.raffle_inventory where raffle_id=r.id and item_id=prize.item_id;
   if coalesce(q,0)>=prize.quantity then
    perform khub_bot.queue(prefix||':prize',null,null,r.winner_player_id,'sale_item',0,jsonb_build_array(jsonb_build_object('id',prize.item_id,'quantity',prize.quantity)),'Your kHub raffle prize: '||r.name);
    update khub_bot.raffle_inventory set quantity=quantity-prize.quantity where raffle_id=r.id and item_id=prize.item_id;
    update khub_bot.raffle_accounts set prize_queued=true where raffle_id=r.id;
   else
    perform khub_bot.queue(prefix||':admin',null,null,a.admin_player_id,'notice',0,'[]','Prize needed for '||r.name||': '||(prize.quantity-coalesce(q,0))||' x '||prize.name||' (item #'||prize.item_id||'). KMail SUPPLY '||r.id||' with the missing items. Available advance: '||to_char(khub_bot.raffle_available_advance(r.id),'FM999,999,999,999,999,999,999')||' Meat. KMail ADVANCE '||r.id||' <amount> with no attachments. Delivery target: 30 minutes after closing.');
   end if;
  end if;
  if r.state='fulfilling' then
   complete:=exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%') and not exists(select 1 from khub_bot.deliveries where dedupe_key like prefix||':prize:%' and state<>'sent');
   if not complete then
    if clock_timestamp()>r.ends_at+interval '30 minutes' then
     perform khub_bot.queue(prefix||':delay',null,null,r.winner_player_id,'notice',0,'[]','Your prize from '||r.name||' is still being prepared. We have passed our 30-minute delivery target, and the administrator has been notified. Thanks for your patience!');
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
notify pgrst,'reload schema';
commit;
