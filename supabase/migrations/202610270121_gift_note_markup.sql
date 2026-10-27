-- Apply once after 120. Accept equivalent game-owned inside-note separator
-- markup while retaining original raw KMail and every existing proof/lock check.
begin;
select pg_advisory_xact_lock(3888760);
do $patch$
declare definition text;
    anchor text:=$old$strpos(coalesce(p_mail#>>'{raw,gift_original,message}',''),'<p>Inside Note:<p>')=0$old$;
begin
    definition:=pg_get_functiondef('public.bot_finish_gift_open(uuid,jsonb,jsonb)'::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
        raise exception 'Unexpected gift-proof definition; review before applying markup compatibility.';
    end if;
    definition:=replace(definition,anchor,$new$coalesce(p_mail#>>'{raw,gift_original,message}','') !~* '<p([[:space:]][^>]*)?>[[:space:]]*Inside[[:space:]]+Note:[[:space:]]*(</p>[[:space:]]*)?<p([[:space:]][^>]*)?>'$new$);
    execute definition;
end; $patch$;
notify pgrst,'reload schema';
commit;
