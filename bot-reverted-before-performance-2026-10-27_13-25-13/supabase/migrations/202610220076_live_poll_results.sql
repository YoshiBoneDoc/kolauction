-- Apply after 075, then deploy the website. Existing votes and archived results
-- are unchanged. No bot rebuild/restart is required.
begin;
create or replace function public.read_home_poll() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid; administrator boolean; poll khub_bot.site_polls%rowtype; result jsonb; voted boolean;
begin
    actor:=khub_bot.require_poll_voter();
    administrator:=khub_bot.is_administrator(actor);
    select * into poll from khub_bot.site_polls p
        where p.published_at is not null and (administrator or p.active)
        order by p.active desc,p.published_at desc,p.id limit 1;
    if not found then return null; end if;
    voted:=exists(select 1 from khub_bot.site_poll_votes v where v.poll_id=poll.id and v.voter_id=actor);
    result:=jsonb_build_object('id',poll.id,'question',poll.question,'active',poll.active,
        'can_manage',administrator,'has_voted',voted);
    if administrator or voted then
        result:=result||jsonb_build_object('results',coalesce(poll.final_results,khub_bot.poll_results(poll.id)));
    end if;
    return result;
end; $$;

-- Names have a separate administrator-only endpoint. Public/homepage responses
-- continue to contain aggregate counts only, never voter identities.
create function public.read_poll_voters(p_poll_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
    perform khub_bot.require_poll_voter();
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if not exists(select 1 from khub_bot.site_polls where id=p_poll_id) then raise exception 'Poll not found.'; end if;
    return (select jsonb_build_object(
        'yes',coalesce(jsonb_agg(p.khub_username order by lower(p.khub_username),p.id) filter(where v.answer),'[]'::jsonb),
        'no',coalesce(jsonb_agg(p.khub_username order by lower(p.khub_username),p.id) filter(where not v.answer),'[]'::jsonb))
        from khub_bot.site_poll_votes v join public.profiles p on p.id=v.voter_id where v.poll_id=p_poll_id);
end; $$;
revoke all on function public.read_poll_voters(uuid) from public,anon,authenticated;
grant execute on function public.read_poll_voters(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
