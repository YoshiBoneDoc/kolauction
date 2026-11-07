-- After 243. Build the existing public whitelist directly; don't serialize
-- every private auction column only to discard it for each Home/browse card.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text; matched text[]; arguments text; field_count integer;
begin
 source:=pg_get_functiondef('khub_bot.public_listing_projection(public.auctions,bigint,text,text)'::regprocedure);
 matched:=regexp_match(source,$rx$(\(select jsonb_object_agg\(key,value\) from jsonb_each\(to_jsonb\(a\)\) where key in \(([^)]+)\)\))$rx$);
 if matched is null or strpos(matched[2],'''mr_a_rate''')=0 then
   raise exception 'Unexpected public card whitelist; inspect installed projection';
 end if;
 select string_agg(format('%L,a.%I',m[1],m[1]),',' order by ordinal),count(*)
 into arguments,field_count
 from regexp_matches(matched[2],$rx$'([a-z_]+)'$rx$,'g') with ordinality as fields(m,ordinal);
 if field_count<30 or field_count>49 or exists(
   select 1 from regexp_matches(matched[2],$rx$'([a-z_]+)'$rx$,'g') fields(m)
   where not exists(select 1 from pg_attribute where attrelid='public.auctions'::regclass
     and attname=m[1] and attnum>0 and not attisdropped)) then
   raise exception 'Unexpected public card fields';
 end if;
 execute replace(source,matched[1],'jsonb_build_object('||arguments||')');
end $patch$;
notify pgrst,'reload schema';
commit;
