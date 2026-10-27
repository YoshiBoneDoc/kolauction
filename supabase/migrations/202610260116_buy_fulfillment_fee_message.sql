-- Apply after 115. Buy-fulfillment payment wording only; no bot restart required.
-- Existing queued/sent messages and all financial records remain untouched.
begin;
select pg_advisory_xact_lock(3888760);
do $patch$
declare
    definition text;
    previous text := 'Fees are paid separately by the buyer.';
    replacement text := 'You pay no fees for this transaction.';
begin
    definition := pg_get_functiondef('khub_bot.ingest_before_buy_reservations(jsonb)'::regprocedure);
    if strpos(definition,previous)=0 then
        if strpos(definition,replacement)>0 then return; end if;
        raise exception 'Unexpected Buy-fulfillment payment message template.';
    end if;
    if (length(definition)-length(replace(definition,previous,'')))/length(previous)<>1 then
        raise exception 'Expected exactly one Buy-fulfillment fee sentence.';
    end if;
    execute replace(definition,previous,replacement);
end; $patch$;
commit;
