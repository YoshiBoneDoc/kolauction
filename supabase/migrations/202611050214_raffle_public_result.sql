-- Apply after 213. Expose only the selected result, never private draw inputs.
begin;
create function public.read_raffle_result(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.can_view_raffles(),false) then raise exception 'Raffle access required' using errcode='42501'; end if;
 return (select jsonb_build_object('winner_name',coalesce(nullif(p.kol_player_name,''),p.khub_username,'Player #'||r.winner_player_id),
 'profile_id',p.id,'winning_ticket',((a.draw_result->>'winningTicket')::numeric+a.ticket_label_offset)::text)
 from public.mystery_raffles r join khub_bot.raffle_accounts a on a.raffle_id=r.id
 left join public.profiles p on p.kol_player_id=r.winner_player_id
 where r.id=p_id and r.selected_outcome is not null and r.winner_player_id is not null and a.draw_result is not null);
end $$;
revoke all on function public.read_raffle_result(uuid) from public,anon,authenticated,service_role;
grant execute on function public.read_raffle_result(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
