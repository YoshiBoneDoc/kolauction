-- Apply after 101, then deploy the website. No bot rebuild is required.
-- Existing Yes/No votes, free-text responses, inbox threads and snapshots are preserved.
begin;
select pg_advisory_xact_lock(3888775);
alter table khub_bot.site_polls drop constraint site_polls_poll_type_check,
    add constraint site_polls_poll_type_check check(poll_type in ('yes_no','free_text','multiple_choice')),
    add column choices text[] not null default '{}',
    add constraint site_poll_choices_kind check(
        (poll_type='multiple_choice' and cardinality(choices) between 2 and 8)
        or (poll_type<>'multiple_choice' and cardinality(choices)=0));
alter table khub_bot.site_poll_votes drop constraint site_poll_response_kind,
    add column choice_index integer check(choice_index between 1 and 8),
    add constraint site_poll_response_kind check(
        (answer is not null and response_text is null and response_report_id is null and choice_index is null)
        or (answer is null and response_text is not null and char_length(response_text) between 1 and 1500 and response_report_id is not null and choice_index is null)
        or (answer is null and response_text is null and response_report_id is null and choice_index is not null));

drop function public.save_poll_draft(text,uuid,text,boolean);
create function public.save_poll_draft(p_question text,p_poll_id uuid default null,p_poll_type text default 'yes_no',
    p_allow_multiple boolean default false,p_choices text[] default '{}') returns uuid
language plpgsql security definer set search_path='' as $$
declare ident uuid; question_text text:=btrim(p_question); normalized text[];
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    if question_text is null or char_length(question_text) not between 10 and 300 then raise exception 'Use a question of 10 to 300 characters.';end if;
    if p_poll_type is null or p_poll_type not in ('yes_no','free_text','multiple_choice') then raise exception 'Choose a valid poll type.';end if;
    if p_allow_multiple is null or p_allow_multiple and p_poll_type<>'free_text' then raise exception 'Multiple responses are only available for free-text polls.';end if;
    select coalesce(array_agg(btrim(c) order by ordinal),'{}') into normalized from unnest(p_choices) with ordinality x(c,ordinal);
    if p_choices is null or (p_poll_type='multiple_choice' and (
        cardinality(normalized) not between 2 and 8
        or exists(select 1 from unnest(normalized) c where c is null or char_length(c) not between 1 and 120)
        or (select count(distinct lower(c)) from unnest(normalized) c)<>cardinality(normalized)))
        or (p_poll_type<>'multiple_choice' and cardinality(normalized)<>0) then
        raise exception 'Enter 2 to 8 different choices, each 1 to 120 characters. Only multiple-choice polls use choices.';end if;
    perform pg_advisory_xact_lock(3888775);
    if p_poll_id is null then
        insert into khub_bot.site_polls(question,poll_type,allow_multiple_responses,choices)
            values(question_text,p_poll_type,p_allow_multiple,normalized) returning id into ident;
    else
        update khub_bot.site_polls set question=question_text,poll_type=p_poll_type,
            allow_multiple_responses=p_allow_multiple,choices=normalized
            where id=p_poll_id and published_at is null returning id into ident;
        if not found then raise exception 'Only unpublished drafts can be edited.';end if;
    end if;
    return ident;
end;$$;

create function public.vote_home_poll_choice(p_poll_id uuid,p_choice integer) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype; next_id uuid;
begin
    actor:=khub_bot.require_poll_voter();
    perform pg_advisory_xact_lock(hashtextextended('poll-voter:'||actor::text,3888775));
    select * into poll from khub_bot.site_polls where id=p_poll_id for share;
    if not found or not poll.active then raise exception 'This poll is closed.';end if;
    if poll.poll_type<>'multiple_choice' then raise exception 'This is not a multiple-choice poll.';end if;
    if p_choice is null or p_choice not between 1 and cardinality(poll.choices) then raise exception 'Choose one of the listed options.';end if;
    if exists(select 1 from khub_bot.site_poll_votes where poll_id=p_poll_id and voter_id=actor) then return;end if;
    select p.id into next_id from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if p_poll_id is distinct from next_id then raise exception 'Answer the preceding poll first.';end if;
    insert into khub_bot.site_poll_votes(poll_id,voter_id,choice_index) values(poll.id,actor,p_choice)
        on conflict(poll_id,voter_id) do nothing;
end;$$;

create or replace function khub_bot.poll_results(p_poll_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare poll khub_bot.site_polls%rowtype; result jsonb;
begin
    select * into poll from khub_bot.site_polls where id=p_poll_id;
    if poll.poll_type='free_text' then
        return jsonb_build_object('total',(select count(*) from khub_bot.bug_reports where poll_id=p_poll_id));
    elsif poll.poll_type='multiple_choice' then
        with counts as (select choice_index,count(*) as n from khub_bot.site_poll_votes where poll_id=p_poll_id group by choice_index)
        select jsonb_build_object('total',coalesce((select sum(n) from counts),0),'choices',jsonb_agg(
            jsonb_build_object('index',x.ordinal,'label',x.label,'count',coalesce(c.n,0)) order by x.ordinal))
            into result from unnest(poll.choices) with ordinality x(label,ordinal) left join counts c on c.choice_index=x.ordinal;
        return result;
    end if;
    return (select jsonb_build_object('yes',count(*) filter(where answer),'no',count(*) filter(where not answer),'total',count(*))
        from khub_bot.site_poll_votes where poll_id=p_poll_id);
end;$$;

create or replace function public.read_poll_voters(p_poll_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare poll khub_bot.site_polls%rowtype;
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    select * into poll from khub_bot.site_polls where id=p_poll_id;
    if not found then raise exception 'Poll not found.';end if;
    if poll.poll_type='multiple_choice' then
        return (select jsonb_build_object('choices',jsonb_agg(jsonb_build_object('index',x.ordinal,'label',x.label,'voters',
            coalesce((select jsonb_agg(p.khub_username order by lower(p.khub_username),p.id)
                from khub_bot.site_poll_votes v join public.profiles p on p.id=v.voter_id
                where v.poll_id=poll.id and v.choice_index=x.ordinal),'[]'::jsonb)) order by x.ordinal))
            from unnest(poll.choices) with ordinality x(label,ordinal));
    end if;
    return (select jsonb_build_object('yes',coalesce(jsonb_agg(p.khub_username order by lower(p.khub_username),p.id) filter(where v.answer),'[]'::jsonb),
        'no',coalesce(jsonb_agg(p.khub_username order by lower(p.khub_username),p.id) filter(where not v.answer),'[]'::jsonb))
        from khub_bot.site_poll_votes v join public.profiles p on p.id=v.voter_id where v.poll_id=p_poll_id);
end;$$;

-- Share the same queue and privacy-filtered results feed; never include totals
-- for an unanswered poll or identities in any ordinary feed.
do $$declare d text; target text;
begin
    d:=pg_get_functiondef('public.read_home_poll()'::regprocedure);
    target:=$t$'poll_type',poll.poll_type$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected poll reader.';end if;
    execute replace(d,target,target||$t$,'choices',poll.choices$t$);
    d:=pg_get_functiondef('public.read_home_poll_feed()'::regprocedure);
    target:=$t$p.poll_type='yes_no'$t$;
    if strpos(d,target)=0 then raise exception 'Unexpected poll results feed.';end if;
    d:=replace(d,target,$t$p.poll_type<>'free_text'$t$);
    execute replace(d,$t$'poll_type',p.poll_type$t$,$t$'poll_type',p.poll_type,'choices',p.choices$t$);
    d:=pg_get_functiondef('public.vote_home_poll(uuid,boolean)'::regprocedure);
    execute replace(d,$t$if poll.poll_type<>'yes_no' then$t$,$t$if poll.poll_type='multiple_choice' then raise exception 'Choose one of the listed options.';end if; if poll.poll_type<>'yes_no' then$t$);
    d:=pg_get_functiondef('public.respond_to_home_poll(uuid,text,uuid)'::regprocedure);
    execute replace(d,$t$if poll.poll_type<>'free_text' then$t$,$t$if poll.poll_type='multiple_choice' then raise exception 'Choose one of the listed options.';end if; if poll.poll_type<>'free_text' then$t$);
end;$$;
revoke all on function public.save_poll_draft(text,uuid,text,boolean,text[]),public.vote_home_poll_choice(uuid,integer) from public,anon,authenticated;
grant execute on function public.save_poll_draft(text,uuid,text,boolean,text[]),public.vote_home_poll_choice(uuid,integer) to authenticated;
notify pgrst,'reload schema';
commit;
