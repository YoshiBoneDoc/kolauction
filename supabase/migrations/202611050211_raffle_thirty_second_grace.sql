-- Apply after 210. Align raffle draw grace with auction settlement (194).
-- Receipt deadlines, complete-scan checks and intake holds are unchanged.
begin;
select pg_advisory_xact_lock(3888760);
do $$
declare source text; anchor text:='ends_at+interval ''60 seconds''<=';
begin
 source:=pg_get_functiondef('public.bot_raffle_draw_work()'::regprocedure);
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected raffle draw grace definition';
 end if;
 execute replace(source,anchor,'ends_at+interval ''30 seconds''<=');
end $$;
notify pgrst,'reload schema';
commit;
