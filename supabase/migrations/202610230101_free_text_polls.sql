-- Apply after 100, then deploy the website. Existing Yes/No polls are preserved.
-- Responses are private Other inbox messages grouped by poll, not individual threads.
-- No bot rebuild required; this feature never queues a KMail per response.
begin;
select pg_advisory_xact_lock(3888760);
select pg_advisory_xact_lock(3888775);
alter table khub_bot.site_polls add column poll_type text not null default 'yes_no'
    check(poll_type in ('yes_no','free_text')),
    add column allow_multiple_responses boolean not null default false,
    add constraint poll_multiple_text_only check(not allow_multiple_responses or poll_type='free_text');
alter table khub_bot.bug_reports add column poll_id uuid references khub_bot.site_polls(id);
-- Legacy email accounts may answer polls before linking a KoL character. Keep
-- their actual missing identity null rather than inventing a recipient number.
alter table khub_bot.bug_reports alter column reporter_kol_id drop not null;
create index bug_reports_poll_thread on khub_bot.bug_reports(poll_id,created_at,report_number) where poll_id is not null;
alter table khub_bot.site_poll_votes alter column answer drop not null,
    add column response_text text,
    add column response_report_id uuid unique references khub_bot.bug_reports(id),
    add constraint site_poll_response_kind check(
        (answer is not null and response_text is null and response_report_id is null)
        or (answer is null and response_text is not null and char_length(response_text) between 1 and 1500 and response_report_id is not null));

-- Replace the signature, avoiding ambiguous PostgREST overloads. Old callers
-- omitting the new argument still create Yes/No drafts.
drop function public.save_poll_draft(text,uuid);
create function public.save_poll_draft(p_question text,p_poll_id uuid default null,p_poll_type text default 'yes_no',p_allow_multiple boolean default false) returns uuid
language plpgsql security definer set search_path='' as $$
declare ident uuid; question_text text:=btrim(p_question);
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    if question_text is null or char_length(question_text) not between 10 and 300 then raise exception 'Use a question of 10 to 300 characters.';end if;
    if p_poll_type is null or p_poll_type not in ('yes_no','free_text') then raise exception 'Choose a valid poll type.';end if;
    if p_allow_multiple is null or p_allow_multiple and p_poll_type<>'free_text' then raise exception 'Multiple responses are only available for free-text polls.';end if;
    perform pg_advisory_xact_lock(3888775);
    if p_poll_id is null then
        insert into khub_bot.site_polls(question,poll_type,allow_multiple_responses) values(question_text,p_poll_type,p_allow_multiple) returning id into ident;
    else
        update khub_bot.site_polls set question=question_text,poll_type=p_poll_type,allow_multiple_responses=p_allow_multiple
            where id=p_poll_id and published_at is null returning id into ident;
        if not found then raise exception 'Only unpublished drafts can be edited.';end if;
    end if;
    return ident;
end;$$;

create or replace function khub_bot.poll_results(p_poll_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    select case when (select poll_type from khub_bot.site_polls where id=p_poll_id)='free_text'
        then jsonb_build_object('total',(select count(*) from khub_bot.bug_reports where poll_id=p_poll_id))
        else jsonb_build_object('yes',count(*) filter(where answer),'no',count(*) filter(where not answer),'total',count(*)) end
    from khub_bot.site_poll_votes where poll_id=p_poll_id;
$$;

create function public.respond_to_home_poll(p_poll_id uuid,p_response text,p_request_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype; player public.profiles%rowtype;
    response text:=btrim(p_response); next_id uuid; report uuid; answered boolean; previous khub_bot.bug_reports%rowtype;
begin
    actor:=khub_bot.require_poll_voter();
    if khub_bot.is_administrator(actor) then raise exception 'Administrators review responses in the inbox.';end if;
    if p_request_id is null then raise exception 'A response request ID is required.';end if;
    if response is null or char_length(response) not between 1 and 1500 then raise exception 'Use a response of 1 to 1,500 characters.';end if;
    -- Same inbox lock order as thread resolution; serialize this account's mixed
    -- text/Yes-No submissions and keep the poll open through the atomic write.
    perform pg_advisory_xact_lock(3888760);
    perform pg_advisory_xact_lock(hashtextextended('poll-voter:'||actor::text,3888775));
    select * into poll from khub_bot.site_polls where id=p_poll_id for share;
    if not found then raise exception 'This poll is closed.';end if;
    select * into previous from khub_bot.bug_reports where id=p_request_id;
    if found then
        if previous.poll_id is distinct from poll.id or previous.reporter_id<>actor or previous.body<>'Poll: '||poll.question||E'\n\n'||response then
            raise exception 'This response request ID is already in use.';end if;
        return;
    end if;
    if not poll.active then raise exception 'This poll is closed.';end if;
    if poll.poll_type<>'free_text' then raise exception 'Choose Yes or No for this poll.';end if;
    answered:=exists(select 1 from khub_bot.site_poll_votes where poll_id=p_poll_id and voter_id=actor);
    if answered and not poll.allow_multiple_responses then return;end if;
    if poll.allow_multiple_responses and (select count(*) from khub_bot.bug_reports where poll_id=poll.id and reporter_id=actor and created_at>clock_timestamp()-interval '1 hour')>=10 then
        raise exception 'Please wait before sending more responses to this poll (10 per hour).';end if;
    select p.id into next_id from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if not answered and p_poll_id is distinct from next_id then raise exception 'Answer the preceding poll first.';end if;
    select * into player from public.profiles where id=actor;
    report:=p_request_id;
    insert into khub_bot.bug_reports(id,reporter_id,reporter_username,reporter_kol_id,body,category,poll_id)
        values(report,actor,player.khub_username,player.kol_player_id,'Poll: '||poll.question||E'\n\n'||response,'other',poll.id);
    insert into khub_bot.site_poll_votes(poll_id,voter_id,response_text,response_report_id)
        values(poll.id,actor,response,report) on conflict(poll_id,voter_id) do nothing;
end;$$;

-- Preserve the existing ordered queue and admin-only live results. Text answers
-- never appear in a public/ordinary feed, even after submission or conclusion.
do $$declare d text; target text;
begin
    target:=$t$'question',poll.question$t$;
    d:=pg_get_functiondef('public.read_home_poll()'::regprocedure);
    if strpos(d,target)=0 then raise exception 'Unexpected home poll reader.';end if;
    execute replace(d,target,target||$t$,'poll_type',poll.poll_type,'allow_multiple_responses',poll.allow_multiple_responses$t$);
    target:=$t$if not found or not poll.active then raise exception 'This poll is closed.'; end if;$t$;
    d:=pg_get_functiondef('public.vote_home_poll(uuid,boolean)'::regprocedure);
    if strpos(d,target)=0 then raise exception 'Unexpected Yes/No vote guard.';end if;
    execute replace(d,target,target||$t$ if poll.poll_type<>'yes_no' then raise exception 'Submit a written response for this poll.';end if;$t$);
    d:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
    d:=replace(d,$t$'question',p.question$t$,$t$'question',p.question,'poll_type',p.poll_type,'allow_multiple_responses',p.allow_multiple_responses$t$);
    target:='where p.active and (administrator or v.voter_id is not null)';
    if strpos(d,target)=0 then raise exception 'Unexpected answered poll feed.';end if;
    d:=replace(d,target,$t$where p.active and (administrator or p.poll_type='yes_no' and v.voter_id is not null)$t$);
    d:=replace(d,'where p.results_published and p.closed_at is not null',$t$where p.poll_type='yes_no' and p.results_published and p.closed_at is not null$t$);
    target:=$t$'answered_polls',coalesce$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected poll feed envelope.';end if;
    d:=replace(d,target,$t$'repeatable_polls',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'question',p.question,'poll_type',p.poll_type,'allow_multiple_responses',true,'active',true) order by p.published_at,p.id)
        from khub_bot.site_polls p where p.active and p.poll_type='free_text' and p.allow_multiple_responses and not administrator
        and exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)),'[]'::jsonb),$t$||target);
    execute d;
    d:=pg_get_functiondef('public.publish_poll_results(uuid,boolean)'::regprocedure);
    target:='perform pg_advisory_xact_lock(3888775);';
    if strpos(d,target)=0 then raise exception 'Unexpected poll results publisher.';end if;
    execute replace(d,target,target||$t$ if exists(select 1 from khub_bot.site_polls where id=p_poll_id and poll_type='free_text') then raise exception 'Written responses stay private in the administrator inbox.';end if;$t$);
end;$$;

-- Group BEFORE category/status filtering and pagination. Keep all existing trade,
-- withdrawal and appeal evidence projections intact.
do $$declare d text; target text;
begin
    d:=pg_get_functiondef('public.read_support_threads(text,text,integer)'::regprocedure);
    target:='coalesce(t.auction_id,q.auction_id,r.id)';
    if strpos(d,target)=0 then raise exception 'Unexpected inbox grouping.';end if;
    d:=replace(d,target,'coalesce(t.auction_id,q.auction_id,r.poll_id,r.id)');
    target:=$t$'auction',case when a.id is not null$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected inbox projection.';end if;
    d:=replace(d,target,$t$'poll',(select jsonb_build_object('id',p.id,'question',p.question) from khub_bot.site_polls p where p.id=g.thread_id and not g.is_trade),$t$||target);
    d:=replace(d,$t$else 'general' end$t$,$t$when r.poll_id is not null then 'poll_response' else 'general' end$t$);
    execute d;
    d:=pg_get_functiondef('public.update_support_thread(uuid,boolean,text,text)'::regprocedure);
    target:='not p_is_trade and br.id=p_thread_id';
    if strpos(d,target)=0 then raise exception 'Unexpected inbox thread update.';end if;
    execute replace(d,target,'not p_is_trade and (br.id=p_thread_id or br.poll_id=p_thread_id)');
end;$$;
revoke all on function public.save_poll_draft(text,uuid,text,boolean),public.respond_to_home_poll(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.save_poll_draft(text,uuid,text,boolean),public.respond_to_home_poll(uuid,text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
