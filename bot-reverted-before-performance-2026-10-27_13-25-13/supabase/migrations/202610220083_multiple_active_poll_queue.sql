-- Apply after 082, before deploying the queued homepage polls and poll manager.
-- Existing votes and frozen result snapshots are unchanged. No bot update required.
begin;
select pg_advisory_xact_lock(3888775);
drop index khub_bot.site_polls_one_active;
create index site_polls_active_queue on khub_bot.site_polls(published_at,id) where active;

create or replace function public.publish_poll(p_poll_id uuid,p_conclude_current boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare poll khub_bot.site_polls%rowtype;
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    -- Old cached managers automatically requested replacement. Fail explicitly
    -- instead of silently concluding several live polls with that old action.
    if p_conclude_current is true then raise exception 'Publish polls independently. Conclude a specific poll separately.'; end if;
    perform pg_advisory_xact_lock(3888775);
    select * into poll from khub_bot.site_polls where id=p_poll_id for update;
    if not found then raise exception 'Poll not found.'; end if;
    if poll.active then return; end if;
    if poll.published_at is not null then raise exception 'Concluded polls cannot be reopened. Create a new draft.'; end if;
    update khub_bot.site_polls set active=true,published_at=clock_timestamp() where id=p_poll_id;
end; $$;

create or replace function public.read_home_poll() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype;
begin
    actor:=khub_bot.require_poll_voter();
    select * into poll from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if not found then return null; end if;
    -- Even the homepage administrator view waits for a vote; full totals and
    -- all voter identities remain available through the private poll manager.
    return jsonb_build_object('id',poll.id,'question',poll.question,'active',true,
        'can_manage',khub_bot.is_administrator(actor),'has_voted',false);
end; $$;

create or replace function public.read_home_poll_feed() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; administrator boolean;
begin
    actor:=khub_bot.require_poll_voter(); administrator:=khub_bot.is_administrator(actor);
    return jsonb_build_object('poll',public.read_home_poll(),'can_manage',administrator,
        'answered_polls',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'question',p.question,
            'active',true,'has_voted',true,'can_manage',administrator,'results',khub_bot.poll_results(p.id))
            order by p.published_at,p.id)
            from khub_bot.site_polls p join khub_bot.site_poll_votes v on v.poll_id=p.id and v.voter_id=actor
            where p.active),'[]'::jsonb),
        'published_results',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'question',p.question,
            'closed_at',p.closed_at,'has_voted',true,'results',p.final_results) order by p.closed_at desc,p.id)
            from khub_bot.site_polls p join khub_bot.site_poll_votes v on v.poll_id=p.id and v.voter_id=actor
            where p.results_published and p.closed_at is not null),'[]'::jsonb));
end; $$;

create or replace function public.vote_home_poll(p_poll_id uuid,p_answer boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype; next_id uuid;
begin
    actor:=khub_bot.require_poll_voter();
    if p_answer is null then raise exception 'Choose Yes or No.'; end if;
    -- Serialize only this account's submissions, including opposite answers or
    -- requests for different polls from several tabs. Other voters stay concurrent.
    perform pg_advisory_xact_lock(hashtextextended('poll-voter:'||actor::text,3888775));
    select * into poll from khub_bot.site_polls where id=p_poll_id for share;
    if not found or not poll.active then raise exception 'This poll is closed.'; end if;
    if exists(select 1 from khub_bot.site_poll_votes where poll_id=p_poll_id and voter_id=actor) then return; end if;
    select p.id into next_id from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if p_poll_id is distinct from next_id then raise exception 'Answer the preceding poll first.'; end if;
    insert into khub_bot.site_poll_votes(poll_id,voter_id,answer) values(p_poll_id,actor,p_answer)
        on conflict(poll_id,voter_id) do nothing;
end; $$;
notify pgrst,'reload schema';
commit;
