-- Apply after 102, then deploy the website. No bot rebuild required.
-- Skipping is private queue progress, never a vote, response or inbox message.
begin;
select pg_advisory_xact_lock(3888775);
create table khub_bot.site_poll_skips (
    poll_id uuid not null references khub_bot.site_polls(id) on delete cascade,
    voter_id uuid not null references public.profiles(id) on delete cascade,
    skipped_at timestamptz not null default clock_timestamp(),
    primary key(poll_id,voter_id)
);
alter table khub_bot.site_poll_skips enable row level security;
revoke all on khub_bot.site_poll_skips from public,anon,authenticated;

-- Reuse the same ordered queue in its reader and all three submission methods.
-- No skipped poll is included in answered results or response counts.
do $$declare d text; signature text; target text;
begin
    target:='and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)';
    foreach signature in array array['public.read_home_poll()','public.vote_home_poll(uuid,boolean)',
        'public.vote_home_poll_choice(uuid,integer)','public.respond_to_home_poll(uuid,text,uuid)'] loop
        d:=pg_get_functiondef(signature::regprocedure);
        if strpos(d,target)=0 then raise exception 'Unexpected poll queue: %',signature;end if;
        execute replace(d,target,target||' and not exists(select 1 from khub_bot.site_poll_skips s where s.poll_id=p.id and s.voter_id=actor)');
    end loop;
end;$$;

create function public.skip_home_poll(p_poll_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype; next_id uuid;
begin
    actor:=khub_bot.require_poll_voter();
    if khub_bot.is_administrator(actor) then raise exception 'Administrators review responses in the inbox.';end if;
    perform pg_advisory_xact_lock(hashtextextended('poll-voter:'||actor::text,3888775));
    select * into poll from khub_bot.site_polls where id=p_poll_id for share;
    if not found then raise exception 'This poll is closed.';end if;
    if poll.poll_type<>'free_text' then raise exception 'Only text polls can be skipped.';end if;
    if exists(select 1 from khub_bot.site_poll_skips where poll_id=p_poll_id and voter_id=actor)
        or exists(select 1 from khub_bot.site_poll_votes where poll_id=p_poll_id and voter_id=actor) then return;end if;
    if not poll.active then raise exception 'This poll is closed.';end if;
    select p.id into next_id from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        and not exists(select 1 from khub_bot.site_poll_skips s where s.poll_id=p.id and s.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if p_poll_id is distinct from next_id then raise exception 'Answer or skip the preceding poll first.';end if;
    insert into khub_bot.site_poll_skips(poll_id,voter_id) values(p_poll_id,actor) on conflict do nothing;
end;$$;
revoke all on function public.skip_home_poll(uuid) from public,anon,authenticated;
grant execute on function public.skip_home_poll(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
