-- Apply after 193 with the Oracle worker stopped, then resume one worker.
-- No bot rebuild or polling change. This changes settlement grace only:
-- anti-sniping, Buy reservation expiry and transport retry waits remain unchanged.
begin;
select pg_advisory_xact_lock(3888760);
do $$
declare target regprocedure; d text;
begin
 foreach target in array array[
   'khub_bot.finish_sell_listing(uuid,text)'::regprocedure,
   'khub_bot.scan_before_buy_reservations(uuid)'::regprocedure,
   'khub_bot.finish_buy_order(uuid,text)'::regprocedure,
   'khub_bot.try_relist_auction(uuid,text)'::regprocedure
 ] loop
   d:=pg_get_functiondef(target);
   if strpos(d,'interval ''60 seconds''')=0 then raise exception 'Unexpected settlement grace source: %',target; end if;
   execute replace(d,'interval ''60 seconds''','interval ''30 seconds''');
 end loop;
 -- Keep existing public projections aligned, including legacy detail wrappers.
 -- Only functions publishing finalization_not_before are eligible for this edit.
 for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname in ('public','khub_bot') and p.prokind='f'
   and strpos(p.prosrc,'''finalization_not_before''')>0
   and strpos(p.prosrc,'interval ''60 seconds''')>0
 loop
   d:=pg_get_functiondef(target);
   execute replace(d,'interval ''60 seconds''','interval ''30 seconds''');
 end loop;
end; $$;
notify pgrst,'reload schema';
commit;
