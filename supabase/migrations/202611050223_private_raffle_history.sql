-- Apply after 222. Self-only history for accepted club members; no financial writes.
begin;
create function khub_bot.is_high_rollers_member(p_user uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p join khub_bot.high_rollers_members m on m.player_id=p.kol_player_id
 where p.id=p_user and m.status='accepted' and not khub_bot.profile_is_restricted(p.id));
$$;
revoke all on function khub_bot.is_high_rollers_member(uuid) from public,anon,authenticated,service_role;
alter function public.read_my_account_access() rename to account_access_before_raffle_history;
alter function public.account_access_before_raffle_history() set schema khub_bot;
revoke all on function khub_bot.account_access_before_raffle_history() from public,anon,authenticated,service_role;
create function public.read_my_account_access() returns jsonb language sql stable security definer set search_path='' as $$
 select khub_bot.account_access_before_raffle_history()||jsonb_build_object('is_high_rollers_member',khub_bot.is_high_rollers_member(auth.uid()));
$$;
create function public.read_my_raffle_history(p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not khub_bot.is_high_rollers_member(auth.uid()) then raise exception 'Accepted club membership required' using errcode='42501'; end if;
 return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id) from (
 select r.id,r.raffle_number::text,r.name,r.state,r.completion_reason,r.ends_at,r.created_at,
 r.ticket_price::text,sum(p.last_ticket-p.first_ticket+1)::text tickets,
 (r.winner_player_id=me.kol_player_id) won
 from public.profiles me join khub_bot.raffle_purchases p on p.player_id=me.kol_player_id
 join public.mystery_raffles r on r.id=p.raffle_id where me.id=auth.uid()
 group by r.id,me.kol_player_id order by r.created_at desc,r.id
 limit 50 offset greatest(0,least(coalesce(p_offset,0),1000000))
 ) x),'[]'::jsonb);
end $$;
revoke all on function public.read_my_account_access(),public.read_my_raffle_history(integer) from public,anon,authenticated;
grant execute on function public.read_my_account_access(),public.read_my_raffle_history(integer) to authenticated;
notify pgrst,'reload schema';
commit;
