-- Apply after 074, then deploy the website. No bot changes are required.
begin;
create table khub_bot.site_polls (
    id uuid primary key default gen_random_uuid(),
    question text not null check (char_length(question) between 10 and 300),
    active boolean not null default false,
    published_at timestamptz,
    results_published boolean not null default false,
    final_results jsonb,
    created_at timestamptz not null default clock_timestamp(),
    closed_at timestamptz,
    check (not active or (published_at is not null and closed_at is null)),
    check (not results_published or (closed_at is not null and final_results is not null))
);
create unique index site_polls_one_active on khub_bot.site_polls(active) where active;
create table khub_bot.site_poll_votes (
    poll_id uuid not null references khub_bot.site_polls(id),
    voter_id uuid not null references public.profiles(id) on delete cascade,
    answer boolean not null,
    created_at timestamptz not null default clock_timestamp(),
    primary key (poll_id,voter_id)
);
alter table khub_bot.site_polls enable row level security;
alter table khub_bot.site_poll_votes enable row level security;
revoke all on khub_bot.site_polls,khub_bot.site_poll_votes from public,anon,authenticated;
grant all on khub_bot.site_polls,khub_bot.site_poll_votes to service_role;

create function khub_bot.require_poll_voter() returns uuid
language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
    if actor is null or not exists(select 1 from public.profiles where id=actor) then
        raise exception 'Log in to vote.' using errcode='42501';
    end if;
    if khub_bot.profile_is_restricted(actor) then
        raise exception 'This account is restricted.' using errcode='42501';
    end if;
    return actor;
end; $$;
revoke all on function khub_bot.require_poll_voter() from public,anon,authenticated,service_role;

create function khub_bot.poll_results(p_poll_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('yes',count(*) filter(where answer),'no',count(*) filter(where not answer),'total',count(*))
    from khub_bot.site_poll_votes where poll_id=p_poll_id;
$$;
revoke all on function khub_bot.poll_results(uuid) from public,anon,authenticated,service_role;

-- A separate locking statement ensures final totals include votes committed
-- while conclusion waited for an in-flight voter to release its shared lock.
create function khub_bot.conclude_poll(p_poll_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare poll khub_bot.site_polls%rowtype;
begin
    select * into poll from khub_bot.site_polls where id=p_poll_id for update;
    if not found or poll.published_at is null then raise exception 'Published poll not found.'; end if;
    if poll.closed_at is not null then return; end if;
    update khub_bot.site_polls set active=false,closed_at=clock_timestamp(),final_results=khub_bot.poll_results(p_poll_id)
        where id=p_poll_id;
end; $$;
revoke all on function khub_bot.conclude_poll(uuid) from public,anon,authenticated,service_role;

create function public.read_home_poll() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; administrator boolean; poll khub_bot.site_polls%rowtype; result jsonb;
begin
    actor:=khub_bot.require_poll_voter();
    administrator:=khub_bot.is_administrator(actor);
    select * into poll from khub_bot.site_polls p
        where p.published_at is not null and (administrator or (p.active and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)))
        order by p.active desc,p.published_at desc,p.id limit 1;
    if not found then return null; end if;
    result:=jsonb_build_object('id',poll.id,'question',poll.question,'active',poll.active,
        'can_manage',administrator,'has_voted',exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=poll.id and v.voter_id=actor));
    if administrator then
        result:=result||jsonb_build_object('results',coalesce(poll.final_results,khub_bot.poll_results(poll.id)));
    end if;
    return result;
end; $$;

create function public.vote_home_poll(p_poll_id uuid,p_answer boolean) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype;
begin
    actor:=khub_bot.require_poll_voter();
    if p_answer is null then raise exception 'Choose Yes or No.'; end if;
    select * into poll from khub_bot.site_polls where id=p_poll_id for share;
    if not found or not poll.active then raise exception 'This poll is closed.'; end if;
    -- Replays are harmless; an existing answer cannot be changed or counted twice.
    insert into khub_bot.site_poll_votes(poll_id,voter_id,answer) values(poll.id,actor,p_answer)
        on conflict (poll_id,voter_id) do nothing;
end; $$;

create function public.close_home_poll(p_poll_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    perform pg_advisory_xact_lock(3888775);
    perform khub_bot.conclude_poll(p_poll_id);
end; $$;
revoke all on function public.read_home_poll(),public.vote_home_poll(uuid,boolean),public.close_home_poll(uuid) from public,anon,authenticated;
grant execute on function public.read_home_poll(),public.vote_home_poll(uuid,boolean),public.close_home_poll(uuid) to authenticated;

-- Home feed exposes only explicitly published concluded results. Active
-- vote totals and all drafts remain private, regardless of request parameters.
create function public.read_home_poll_feed() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    perform khub_bot.require_poll_voter();
    return jsonb_build_object('poll',public.read_home_poll(),'can_manage',khub_bot.is_administrator(auth.uid()),
        'published_results',coalesce((select jsonb_agg(jsonb_build_object('id',id,'question',question,
            'closed_at',closed_at,'results',final_results) order by closed_at desc,id)
            from khub_bot.site_polls where results_published and closed_at is not null),'[]'::jsonb));
end; $$;

create function public.read_admin_polls() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    return coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('results',coalesce(p.final_results,khub_bot.poll_results(p.id)))
        order by p.created_at desc,p.id) from khub_bot.site_polls p),'[]'::jsonb);
end; $$;

create function public.save_poll_draft(p_question text,p_poll_id uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare ident uuid; v_question text:=btrim(p_question);
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if v_question is null or char_length(v_question) not between 10 and 300 then raise exception 'Use a question of 10 to 300 characters.'; end if;
    perform pg_advisory_xact_lock(3888775);
    if p_poll_id is null then
        insert into khub_bot.site_polls(question) values(v_question) returning id into ident;
    else
        update khub_bot.site_polls set question=v_question where id=p_poll_id and published_at is null returning id into ident;
        if not found then raise exception 'Only unpublished drafts can be edited.'; end if;
    end if;
    return ident;
end; $$;

create function public.publish_poll(p_poll_id uuid,p_conclude_current boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare poll khub_bot.site_polls%rowtype; current_id uuid;
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(3888775);
    select * into poll from khub_bot.site_polls where id=p_poll_id for update;
    if not found then raise exception 'Poll not found.'; end if;
    if poll.active then return; end if;
    if poll.published_at is not null then raise exception 'Concluded polls cannot be reopened. Create a new draft.'; end if;
    for current_id in select id from khub_bot.site_polls where active order by id for update loop
        if p_conclude_current is not true then raise exception 'Conclude the current poll before publishing another.'; end if;
        perform khub_bot.conclude_poll(current_id);
    end loop;
    update khub_bot.site_polls set active=true,published_at=clock_timestamp() where id=p_poll_id;
end; $$;

create function public.publish_poll_results(p_poll_id uuid,p_publish boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_publish is null then raise exception 'Choose whether to publish these results.'; end if;
    perform pg_advisory_xact_lock(3888775);
    update khub_bot.site_polls set results_published=p_publish where id=p_poll_id and closed_at is not null and final_results is not null;
    if not found then raise exception 'Conclude the poll before publishing its results.'; end if;
end; $$;

revoke all on function public.read_home_poll_feed(),public.read_admin_polls(),public.save_poll_draft(text,uuid),public.publish_poll(uuid,boolean),public.publish_poll_results(uuid,boolean) from public,anon,authenticated;
grant execute on function public.read_home_poll_feed(),public.read_admin_polls(),public.save_poll_draft(text,uuid),public.publish_poll(uuid,boolean),public.publish_poll_results(uuid,boolean) to authenticated;

insert into khub_bot.site_polls(question,active,published_at) values('Should sellers have the option to end auctions early if they’re happy with the current bid?',true,clock_timestamp());
notify pgrst,'reload schema';
commit;
