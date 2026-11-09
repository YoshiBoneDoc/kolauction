-- Apply after 246 and existing poll/inbox migrations. Website release separately.
-- No worker restart. Existing browser-only favorites are not imported as votes.
begin;
create table khub_bot.poll_font_hearts (
 poll_id uuid not null references khub_bot.site_polls(id) on delete cascade,
 voter_id uuid not null references public.profiles(id) on delete cascade,
 family text not null check(length(family) between 1 and 200 and family=btrim(family)),
 primary key(poll_id,voter_id,family)
);
create index poll_font_hearts_ranking_idx on khub_bot.poll_font_hearts(poll_id,family);
create index poll_font_hearts_voter_idx on khub_bot.poll_font_hearts(voter_id,poll_id) include(family);
alter table khub_bot.poll_font_hearts enable row level security;
revoke all on khub_bot.poll_font_hearts from public,anon,authenticated;
create function khub_bot.font_heart_ranking(p_poll_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r) order by r.hearts desc,r.family),'[]'::jsonb)
 from (select family,count(*)::integer hearts from khub_bot.poll_font_hearts
 where poll_id=p_poll_id group by family order by hearts desc,family limit 50) r;
$$;
revoke all on function khub_bot.font_heart_ranking(uuid) from public,anon,authenticated;
create function public.set_poll_font_heart(p_poll_id uuid,p_family text,p_hearted boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=khub_bot.require_poll_voter(); p khub_bot.site_polls%rowtype; name text:=btrim(p_family);
begin
 if name is null or length(name) not between 1 and 200 or name ~ '[[:cntrl:]]' or p_hearted is null then raise exception 'Invalid font heart.'; end if;
 perform pg_advisory_xact_lock(hashtextextended('font-heart:'||actor::text,3888775));
 select * into p from khub_bot.site_polls where id=p_poll_id for share;
 if not found or not p.active or p.poll_type<>'free_text' or p.question !~* '\mfonts?\M' then raise exception 'This font poll is closed.'; end if;
 if p_hearted then
  if not exists(select 1 from khub_bot.poll_font_hearts where poll_id=p_poll_id and voter_id=actor and family=name)
    and (select count(*) from khub_bot.poll_font_hearts where poll_id=p_poll_id and voter_id=actor)>=100 then raise exception 'Maximum 100 fonts per poll.'; end if;
  insert into khub_bot.poll_font_hearts values(p_poll_id,actor,name) on conflict do nothing;
 else delete from khub_bot.poll_font_hearts where poll_id=p_poll_id and voter_id=actor and family=name; end if;
 return (select coalesce(jsonb_agg(family order by family),'[]'::jsonb) from khub_bot.poll_font_hearts where poll_id=p_poll_id and voter_id=actor);
end;$$;
revoke all on function public.set_poll_font_heart(uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.set_poll_font_heart(uuid,text,boolean) to authenticated;
-- Extend existing feed, keeping its authorization, queue and private response rules.
do $$declare d text;
begin
 d:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 if strpos(d,'return jsonb_build_object(')=0 then raise exception 'Unexpected poll feed definition'; end if;
 d:=replace(d,'return jsonb_build_object(', $r$return jsonb_build_object('font_hearts',coalesce((select jsonb_object_agg(h.poll_id,h.families) from (select f.poll_id,jsonb_agg(f.family order by f.family) families from khub_bot.poll_font_hearts f join khub_bot.site_polls p on p.id=f.poll_id where f.voter_id=auth.uid() and p.active group by f.poll_id) h),'{}'::jsonb),$r$);
 execute d;
 d:=pg_get_functiondef('public.read_support_threads(text,text,integer)'::regprocedure);
 if strpos(d,$r$'question',p.question) from khub_bot.site_polls$r$)=0 then raise exception 'Unexpected poll thread definition'; end if;
 d:=replace(d,$r$'question',p.question) from khub_bot.site_polls$r$,$r$'question',p.question,'font_hearts',khub_bot.font_heart_ranking(p.id)) from khub_bot.site_polls$r$);
 execute d;
end;$$;
notify pgrst,'reload schema';
commit;
