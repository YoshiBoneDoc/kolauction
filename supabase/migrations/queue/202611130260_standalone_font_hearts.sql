-- After 259. Apply once, then deploy the website. No bot restart.
-- Replace the shortlist poll with standalone hearts and private inbox results.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888775);
create table khub_bot.title_font_finalists(family text primary key);
insert into khub_bot.title_font_finalists values
 ('Newsreader'),('Atkinson Hyperlegible'),('Cabin Sketch'),('Grenze Gotisch'),
 ('Handlee'),('Jersey 25 Charted'),('Jomolhari'),('Lexend Exa'),('Mynerve'),
 ('Romanesco'),('Sorts Mill Goudy'),('Stack Sans Text'),('Comic Sans MS');
create table khub_bot.title_font_hearts (
 voter_id uuid not null references public.profiles(id) on delete cascade,
 family text not null references khub_bot.title_font_finalists(family),
 primary key(voter_id,family)
);
create index title_font_hearts_ranking_idx on khub_bot.title_font_hearts(family);
alter table khub_bot.title_font_finalists enable row level security;
alter table khub_bot.title_font_hearts enable row level security;
revoke all on khub_bot.title_font_finalists,khub_bot.title_font_hearts from public,anon,authenticated;
-- Serialize conversion with the old poll's in-flight heart writes.
select id from khub_bot.site_polls where id='a6b64bd4-b96e-48f4-971a-5062c8ba3391' for update;
-- Preserve any shared shortlist hearts already collected. Never import local favorites
-- or the earlier unrestricted font poll. Keep the old rows as historical evidence.
insert into khub_bot.title_font_hearts(voter_id,family)
select h.voter_id,h.family from khub_bot.poll_font_hearts h
join khub_bot.title_font_finalists f using(family)
where h.poll_id='a6b64bd4-b96e-48f4-971a-5062c8ba3391'
on conflict do nothing;
select khub_bot.conclude_poll('a6b64bd4-b96e-48f4-971a-5062c8ba3391')
where exists(select 1 from khub_bot.site_polls where id='a6b64bd4-b96e-48f4-971a-5062c8ba3391');

create function public.set_title_font_heart(p_family text,p_hearted boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare actor uuid:=khub_bot.require_poll_voter(); name text:=btrim(p_family);
begin
 if p_hearted is null or name is null or not exists(select 1 from khub_bot.title_font_finalists where family=name) then
  raise exception 'Choose a shortlisted title font.';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('title-font-heart:'||actor::text,3888775));
 if p_hearted then
  insert into khub_bot.title_font_hearts values(actor,name) on conflict do nothing;
 else
  delete from khub_bot.title_font_hearts where voter_id=actor and family=name;
 end if;
 return (select coalesce(jsonb_agg(family order by family),'[]'::jsonb) from khub_bot.title_font_hearts where voter_id=actor);
end; $$;
revoke all on function public.set_title_font_heart(text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.set_title_font_heart(text,boolean) to authenticated;

create function khub_bot.title_font_heart_results() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_agg(to_jsonb(r) order by r.hearts desc,r.family)
 from (select f.family,count(h.voter_id)::integer hearts from khub_bot.title_font_finalists f
 left join khub_bot.title_font_hearts h using(family) group by f.family) r;
$$;
revoke all on function khub_bot.title_font_heart_results() from public,anon,authenticated,service_role;

do $patch$
declare source text; anchor text;
begin
 source:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
 anchor:='return jsonb_build_object(';
 if strpos(source,anchor)=0 then raise exception 'Unexpected poll feed'; end if;
 execute replace(source,anchor,$replacement$return jsonb_build_object('title_font_hearts',
 (select coalesce(jsonb_agg(family order by family),'[]'::jsonb) from khub_bot.title_font_hearts where voter_id=actor),$replacement$);
 -- Remove the superseded collection from poll management without deleting history.
 source:=pg_get_functiondef('public.read_admin_polls()'::regprocedure);
 anchor:='from khub_bot.site_polls p)';
 if strpos(source,anchor)=0 then raise exception 'Unexpected admin polls'; end if;
 execute replace(source,anchor,'from khub_bot.site_polls p where not p.font_shortlist_round)');
 -- Add one bounded 13-font ranking to the existing authorized inbox response.
 source:=pg_get_functiondef('public.read_support_threads(text,text,integer)'::regprocedure);
 anchor:='return result;';
 if strpos(source,anchor)=0 then raise exception 'Unexpected inbox reader'; end if;
 execute replace(source,anchor,$replacement$return result || case when p_category in ('all','other') and p_page=1
 then jsonb_build_object('title_font_hearts',khub_bot.title_font_heart_results()) else '{}'::jsonb end;$replacement$);
end $patch$;
notify pgrst,'reload schema';
commit;
