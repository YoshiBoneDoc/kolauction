-- Apply after 185, before rebuilding the bot. Reminder message facts only.
begin;
set local lock_timeout='2s';
do $$declare d text;
 select_anchor text:='select s.*,a.auction_number,a.item,';
 result_anchor text:='''item'',r.item,';
begin
 d:=pg_get_functiondef('public.bot_claim_saved_reminder()'::regprocedure);
 if strpos(d,select_anchor)=0 or strpos(d,result_anchor)=0 then raise exception 'Unexpected saved reminder claim';end if;
 d:=replace(d,select_anchor,'select s.*,a.auction_number,a.item,a.quantity,(jsonb_array_length(a.bundle_items)>1) as is_bundle,');
 d:=replace(d,result_anchor,'''item'',r.item,''quantity'',r.quantity::text,''is_bundle'',r.is_bundle,');
 execute d;
end;$$;
notify pgrst,'reload schema';
commit;
