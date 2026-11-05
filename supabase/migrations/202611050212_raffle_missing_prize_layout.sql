-- Apply after 211. Future missing-prize notices only; references remain automatic.
begin;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_raffle_tick()'::regprocedure);
 anchor:=$old$'Prize needed for '||r.name||' (#'||r.raffle_number||')'||': '||(prize.quantity-coalesce(q,0))||' x '||prize.name||' (item #'||prize.item_id||'). KMail SUPPLY '||r.raffle_number||' with the missing items. Available advance: '||to_char(khub_bot.raffle_available_advance(r.id),'FM999,999,999,999,999,999,999')||' Meat. KMail ADVANCE '||r.raffle_number||' <amount> with no attachments. Delivery target: 30 minutes after closing.'$old$;
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected missing-prize message definition';
 end if;
 execute replace(source,anchor,$new$'Prize needed for '||r.name||' (#'||r.raffle_number||'): '||(prize.quantity-coalesce(q,0))||' × '||prize.name||E'\n\nSupply missing items: SUPPLY '||r.raffle_number||E'\n\nAvailable advance: '||to_char(khub_bot.raffle_available_advance(r.id),'FM999,999,999,999,999,999,999')||E' Meat\nRequest advance: ADVANCE '||r.raffle_number||' <amount>'$new$);
end $$;
notify pgrst,'reload schema';
commit;
