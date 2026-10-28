-- Apply after 062. Recognize the audited notices queued by migration 051.
-- No deliveries, financial obligations, saved bodies or send states are changed.
begin;
do $$
declare definition text; anchor text:=$anchor$    -- Unknown/custom ledger messages must be reviewed, never silently prettified.$anchor$;
begin
    definition:=pg_get_functiondef('khub_bot.friendly_message(khub_bot.deliveries)'::regprocedure);
    if strpos(definition,anchor)=0 then
        raise exception 'Unexpected delivery formatter; migration not applied.';
    end if;
    execute replace(definition,anchor,$patch$    -- Ban notices contain server-authored event text. Accept only zero-asset
    -- notices tied to the corresponding restriction/decision audit entry.
    if d.kind='notice' and d.meat=0 and d.quantity=0
        and d.dedupe_key ~ '^ban-(review|decision):[0-9]+:[0-9]+:notice$'
        and nullif(btrim(d.message),'') is not null
        and exists(select 1 from khub_bot.auction_ban_reviews r
            where r.id::text=split_part(d.dedupe_key,':',2) and r.auction_id=d.auction_id
                and ((split_part(d.dedupe_key,':',1)='ban-review' and r.action='restriction')
                    or (split_part(d.dedupe_key,':',1)='ban-decision' and r.action<>'restriction'))) then
        return d.message;
    end if;
$patch$||anchor);
end; $$;
notify pgrst,'reload schema';
commit;
