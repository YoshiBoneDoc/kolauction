-- Apply after 103, then deploy the website. No bot rebuild required.
begin;
select pg_advisory_xact_lock(3888775);
-- Skipped questions remain optional while newer polls continue through the queue.
do $$declare d text; target text;
begin
    d:=pg_get_functiondef('public.respond_to_home_poll(uuid,text,uuid)'::regprocedure);
    target:='if not answered and p_poll_id is distinct from next_id then';
    if strpos(d,target)=0 then raise exception 'Unexpected text response queue guard.';end if;
    execute replace(d,target,'if not answered and p_poll_id is distinct from next_id and not exists(select 1 from khub_bot.site_poll_skips where poll_id=p_poll_id and voter_id=actor) then');
    d:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
    target:=$t$'repeatable_polls',coalesce$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected poll feed.';end if;
    execute replace(d,target,$t$'skipped_polls',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'question',p.question,'poll_type',p.poll_type,
        'allow_multiple_responses',p.allow_multiple_responses,'active',true,'has_voted',false) order by p.published_at,p.id)
        from khub_bot.site_polls p join khub_bot.site_poll_skips s on s.poll_id=p.id and s.voter_id=actor
        where p.active and p.poll_type='free_text' and not administrator
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)),'[]'::jsonb),$t$||target);
end;$$;
notify pgrst,'reload schema';
commit;
