-- Apply after 110. Message wording only; no bot rebuild required.
-- Keep all financial records, saved message bodies and send/recovery state intact.
begin;
do $patch$
declare definition text;
    obsolete text := $line$||case when f.receipt_id is null then E'\nGift delivery expenses (separate): '||khub_bot.format_message_number(o.gift_meat)||' Meat' else '' end$line$;
begin
    definition:=pg_get_functiondef('khub_bot.friendly_message(khub_bot.deliveries)'::regprocedure);
    if strpos(definition,obsolete)=0 then raise exception 'Unexpected Buy-auction fee message template.'; end if;
    execute replace(definition,obsolete,'');
end; $patch$;
commit;
