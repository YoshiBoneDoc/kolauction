-- After 260 (compatible with subsequent migrations through 289).
-- Apply once, then deploy website. Permanently deletes font-heart votes only.
-- Historical migrations remain for reproducible installs; ordinary polls/responses stay.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888775);
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 if strpos(source,$old$return jsonb_build_object('title_font_hearts',
 (select coalesce(jsonb_agg(family order by family),'[]'::jsonb) from khub_bot.title_font_hearts where voter_id=actor),$old$)=0 then raise exception 'Unexpected font feature definition in public.read_home_poll_feed()'; end if;
 execute replace(source,$old$return jsonb_build_object('title_font_hearts',
 (select coalesce(jsonb_agg(family order by family),'[]'::jsonb) from khub_bot.title_font_hearts where voter_id=actor),$old$,$new$return jsonb_build_object($new$);
 source:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 if strpos(source,$old$return jsonb_build_object('font_poll',(select jsonb_build_object('id',p.id,'question',p.question,'active',true,'font_shortlist_round',true)
 from khub_bot.site_polls p where p.font_shortlist_round and p.active order by p.published_at desc,p.id limit 1),$old$)=0 then raise exception 'Unexpected font feature definition in public.read_home_poll_feed()'; end if;
 execute replace(source,$old$return jsonb_build_object('font_poll',(select jsonb_build_object('id',p.id,'question',p.question,'active',true,'font_shortlist_round',true)
 from khub_bot.site_polls p where p.font_shortlist_round and p.active order by p.published_at desc,p.id limit 1),$old$,$new$return jsonb_build_object($new$);
 source:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 if strpos(source,$old$return jsonb_build_object('font_hearts',coalesce((select jsonb_object_agg(h.poll_id,h.families) from (select f.poll_id,jsonb_agg(f.family order by f.family) families from khub_bot.poll_font_hearts f join khub_bot.site_polls p on p.id=f.poll_id where f.voter_id=auth.uid() and p.active group by f.poll_id) h),'{}'::jsonb),$old$)=0 then raise exception 'Unexpected font feature definition in public.read_home_poll_feed()'; end if;
 execute replace(source,$old$return jsonb_build_object('font_hearts',coalesce((select jsonb_object_agg(h.poll_id,h.families) from (select f.poll_id,jsonb_agg(f.family order by f.family) families from khub_bot.poll_font_hearts f join khub_bot.site_polls p on p.id=f.poll_id where f.voter_id=auth.uid() and p.active group by f.poll_id) h),'{}'::jsonb),$old$,$new$return jsonb_build_object($new$);
 source:=pg_get_functiondef('public.read_support_threads(text,text,integer)'::regprocedure);
 if strpos(source,$old$return result || case when p_category in ('all','other') and p_page=1
 then jsonb_build_object('title_font_hearts',khub_bot.title_font_heart_results()) else '{}'::jsonb end;$old$)=0 then raise exception 'Unexpected font feature definition in public.read_support_threads(text,text,integer)'; end if;
 execute replace(source,$old$return result || case when p_category in ('all','other') and p_page=1
 then jsonb_build_object('title_font_hearts',khub_bot.title_font_heart_results()) else '{}'::jsonb end;$old$,$new$return result;$new$);
 source:=pg_get_functiondef('public.read_support_threads(text,text,integer)'::regprocedure);
 if strpos(source,$old$'question',p.question,'font_hearts',khub_bot.font_heart_ranking(p.id)) from khub_bot.site_polls$old$)=0 then raise exception 'Unexpected font feature definition in public.read_support_threads(text,text,integer)'; end if;
 execute replace(source,$old$'question',p.question,'font_hearts',khub_bot.font_heart_ranking(p.id)) from khub_bot.site_polls$old$,$new$'question',p.question) from khub_bot.site_polls$new$);
 source:=pg_get_functiondef('public.read_admin_polls()'::regprocedure);
 if strpos(source,$old$'results',coalesce(p.final_results,khub_bot.poll_results(p.id)),
 'font_hearts',case when p.poll_type='free_text' and p.question ~* '\mfonts?\M' then khub_bot.font_heart_ranking(p.id) else '[]'::jsonb end$old$)=0 then raise exception 'Unexpected font feature definition in public.read_admin_polls()'; end if;
 execute replace(source,$old$'results',coalesce(p.final_results,khub_bot.poll_results(p.id)),
 'font_hearts',case when p.poll_type='free_text' and p.question ~* '\mfonts?\M' then khub_bot.font_heart_ranking(p.id) else '[]'::jsonb end$old$,$new$'results',coalesce(p.final_results,khub_bot.poll_results(p.id))$new$);
 source:=pg_get_functiondef('public.read_admin_polls()'::regprocedure);
 if strpos(source,$old$from khub_bot.site_polls p where not p.font_shortlist_round)$old$)=0 then raise exception 'Unexpected font feature definition in public.read_admin_polls()'; end if;
 execute replace(source,$old$from khub_bot.site_polls p where not p.font_shortlist_round)$old$,$new$from khub_bot.site_polls p where p.id<>'a6b64bd4-b96e-48f4-971a-5062c8ba3391'::uuid)$new$);
end $patch$;
drop function public.set_title_font_heart(text,boolean);
drop function public.set_poll_font_heart(uuid,text,boolean);
drop function khub_bot.title_font_heart_results();
drop function khub_bot.font_heart_ranking(uuid);
drop table khub_bot.title_font_hearts;
drop table khub_bot.title_font_finalists;
drop table khub_bot.poll_font_hearts;
alter table khub_bot.site_polls drop column font_shortlist_round;
notify pgrst,'reload schema';
commit;
