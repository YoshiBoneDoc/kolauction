-- Message wording only, for future bid-help replies with no actual attachments.
-- Existing saved messages, receipt checks, refunds and cleanup stay unchanged.
begin;
do $patch$
declare
    definition text;
    anchor text := '-- Reuse the existing receipt, split refund queue, frozen message and recovery path.';
    notice text := 'Your request was not accepted.';
begin
    definition := pg_get_functiondef('khub_bot.ingest_before_incoming_gifts(jsonb)'::regprocedure);
    if strpos(definition, notice) > 0 then return; end if;
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor) <> 1 then
        raise exception 'Unexpected bid-help implementation; review before changing the missing-attachment reply.';
    end if;
    execute replace(definition, anchor, $code$
    if meat=0 and attachments='[]'::jsonb then
        body:=E'Your request was not accepted.\n\nNo attached Meat or items were detected. Please include the required attachments and resend your command.';
    end if;
    $code$ || anchor);
end; $patch$;
notify pgrst,'reload schema';
commit;
