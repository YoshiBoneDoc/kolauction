-- After 258 and 247. Apply once, then deploy the website. No bot restart.
-- Starts a fresh shortlist round; old poll hearts and written responses stay intact.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888775);
alter table khub_bot.site_polls add column font_shortlist_round boolean not null default false;
insert into khub_bot.site_polls(id,question,poll_type,allow_multiple_responses,active,published_at,font_shortlist_round)
values('a6b64bd4-b96e-48f4-971a-5062c8ba3391',
 'Which of the 13 shortlisted title fonts do you prefer? Shuffle through the fonts and heart your favorites. Written feedback is optional.',
 'free_text',true,true,clock_timestamp(),true);

-- A dedicated feed pointer lets toolbar voting work regardless of poll queue position.
-- Reuse the existing private feed and refresh rather than adding browser reads.
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 if strpos(source,'return jsonb_build_object(')=0 then raise exception 'Unexpected poll feed'; end if;
 execute replace(source,'return jsonb_build_object(',
 $replacement$return jsonb_build_object('font_poll',(select jsonb_build_object('id',p.id,'question',p.question,'active',true,'font_shortlist_round',true)
 from khub_bot.site_polls p where p.font_shortlist_round and p.active order by p.published_at desc,p.id limit 1),$replacement$);
 source:=pg_get_functiondef('public.read_admin_polls()'::regprocedure);
 if strpos(source,'''results'',coalesce(p.final_results,khub_bot.poll_results(p.id))')=0 then raise exception 'Unexpected admin polls'; end if;
 execute replace(source,'''results'',coalesce(p.final_results,khub_bot.poll_results(p.id))',
 $replacement$'results',coalesce(p.final_results,khub_bot.poll_results(p.id)),
 'font_hearts',case when p.poll_type='free_text' and p.question ~* '\mfonts?\M' then khub_bot.font_heart_ranking(p.id) else '[]'::jsonb end$replacement$);
 source:=pg_get_functiondef('public.set_poll_font_heart(uuid,text,boolean)'::regprocedure);
 if strpos(source,'if p_hearted then')=0 then raise exception 'Unexpected heart writer'; end if;
 execute replace(source,'if p_hearted then',
 $replacement$if p.font_shortlist_round and not (name=any(array['Newsreader','Atkinson Hyperlegible','Cabin Sketch','Grenze Gotisch','Handlee','Jersey 25 Charted','Jomolhari','Lexend Exa','Mynerve','Romanesco','Sorts Mill Goudy','Stack Sans Text','Comic Sans MS'])) then
 raise exception 'Choose a shortlisted title font.'; end if;
 if p_hearted then$replacement$);
end $patch$;
notify pgrst,'reload schema';
commit;
