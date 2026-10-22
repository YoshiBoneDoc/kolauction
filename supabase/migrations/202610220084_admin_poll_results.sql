-- Apply after 083. Admin homepage shows every live poll as results without requiring a vote.
-- Read-only change: existing votes and saved totals are preserved. No bot restart required.
begin;
create or replace function public.read_home_poll() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; poll khub_bot.site_polls%rowtype;
begin
    actor:=khub_bot.require_poll_voter();
    if khub_bot.is_administrator(actor) then return null; end if;
    select * into poll from khub_bot.site_polls p where p.active
        and not exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=p.id and v.voter_id=actor)
        order by p.published_at,p.id limit 1;
    if not found then return null; end if;
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
            'active',true,'has_voted',v.voter_id is not null,'can_manage',administrator,'results',khub_bot.poll_results(p.id))
            order by p.published_at,p.id)
            from khub_bot.site_polls p left join khub_bot.site_poll_votes v on v.poll_id=p.id and v.voter_id=actor
            where p.active and (administrator or v.voter_id is not null)),'[]'::jsonb),
        'published_results',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'question',p.question,
            'closed_at',p.closed_at,'has_voted',v.voter_id is not null,'results',p.final_results) order by p.closed_at desc,p.id)
            from khub_bot.site_polls p left join khub_bot.site_poll_votes v on v.poll_id=p.id and v.voter_id=actor
            where p.results_published and p.closed_at is not null and (administrator or v.voter_id is not null)),'[]'::jsonb));
end; $$;

notify pgrst,'reload schema';
commit;
