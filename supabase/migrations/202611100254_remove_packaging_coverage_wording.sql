-- After 253. Wording only; stop the sole worker while applying, then resume.
-- No bot/site rebuild. Preserve all assets, claims, frozen bodies and evidence.
begin;
set local lock_timeout='2s';
select pg_advisory_xact_lock(3888760);
do $patch$
declare target regprocedure; definition text;
    obsolete text:=' Gift packaging is covered by kHub.';
begin
    foreach target in array array[
        'public.bot_prepare_buy_delivery(uuid,boolean)'::regprocedure,
        'khub_bot.finish_buy_order(uuid,text)'::regprocedure
    ] loop
        definition:=pg_get_functiondef(target);
        if strpos(definition,obsolete)=0 then
            raise exception 'Unexpected Buy packaging template in %; inspect installed definitions',target;
        end if;
        execute replace(definition,obsolete,'');
    end loop;
end $patch$;
-- Only never-claimed, unfrozen outgoing wording can be updated. Do not rewrite
-- saved send bodies, batch bodies, delivery evidence, or uncertain attempts.
update khub_bot.deliveries d
set message=replace(d.message,' Gift packaging is covered by kHub.','')
where d.state='pending' and d.attempt is null and d.display_message is null
  and d.mail_batch is null and d.mail_batch_body is null
  and d.message like '% Gift packaging is covered by kHub.%'
  and (d.dedupe_key like 'buy-order-refund:%' or d.dedupe_key like 'buy-batch-items:%');
notify pgrst,'reload schema';
commit;
