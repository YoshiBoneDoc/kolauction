-- Direct Trade 24-hour reminder wording only; no bot restart required.
-- Existing queued/sent messages and trade records remain untouched.
begin;
select pg_advisory_xact_lock(3888760);
do $patch$
declare
    definition text;
    previous text := 'This reminder is scheduled with 24 hours remaining; delivery may be delayed.';
    replacement text := 'This reminder is scheduled with 24 hours remaining.';
begin
    definition := pg_get_functiondef('khub_bot.maintain_direct_trade_reminders(uuid)'::regprocedure);
    if strpos(definition,previous)=0 then
        if strpos(definition,replacement)>0 then return; end if;
        raise exception 'Unexpected Direct Trade reminder message template.';
    end if;
    if (length(definition)-length(replace(definition,previous,'')))/length(previous)<>1 then
        raise exception 'Expected exactly one Direct Trade reminder sentence.';
    end if;
    execute replace(definition,previous,replacement);
end; $patch$;
commit;
