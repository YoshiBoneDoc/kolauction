-- Apply after 254. Wording only; stop the sole worker while applying, then resume.
-- No bot/site rebuild. Preserve financial records and frozen delivery bodies.
begin;
set local lock_timeout='2s';
select pg_advisory_xact_lock(3888760);
do $patch$
declare
    definition text;
    obsolete text := ' You pay no fees for this transaction.';
begin
    definition := pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
    if (length(definition)-length(replace(definition,obsolete,'')))/length(obsolete)<>1 then
        raise exception 'Expected exactly one Buy-fulfillment fee sentence.';
    end if;
    execute replace(definition,obsolete,'');
end $patch$;
-- Update only never-claimed, unfrozen Buy fulfillment payments.
update khub_bot.deliveries d
set message=replace(d.message,' You pay no fees for this transaction.','')
where d.state='pending' and d.attempt is null and d.display_message is null
  and d.mail_batch is null and d.mail_batch_body is null
  and d.dedupe_key like 'buy-fill-payment:%'
  and d.message like '% You pay no fees for this transaction.%';
notify pgrst,'reload schema';
commit;
