-- Apply after 219. Existing members must accept the invitation too.
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.high_rollers_members add column status text not null default 'pending' check(status in ('pending','accepted','declined')), add column accepted_at timestamptz, add column accepted_terms_version text;
alter table khub_bot.high_rollers_members add check((status='accepted' and accepted_at is not null and accepted_terms_version is not null) or (status<>'accepted' and accepted_at is null and accepted_terms_version is null));
create function public.read_my_high_rollers_invitation() returns text language sql stable security definer set search_path='' as $$
 select '1'::text from khub_bot.high_rollers_members m join public.profiles p on p.kol_player_id=m.player_id where p.id=auth.uid() and m.status='pending' and not khub_bot.profile_is_restricted(p.id);
$$;
create function public.respond_high_rollers_invitation(p_accept boolean,p_terms_version text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(3888760);
 if p_accept is null or p_terms_version is distinct from '1' then raise exception 'Invitation terms changed. Please refresh.'; end if;
 update khub_bot.high_rollers_members m set status=case when p_accept then 'accepted' else 'declined' end,accepted_at=case when p_accept then clock_timestamp() end,accepted_terms_version=case when p_accept then '1' end
 from public.profiles p where p.id=auth.uid() and p.kol_player_id=m.player_id and m.status='pending' and not khub_bot.profile_is_restricted(p.id);
 if not found then raise exception 'No pending invitation'; end if;
end $$;
revoke all on function public.read_my_high_rollers_invitation(),public.respond_high_rollers_invitation(boolean,text) from public,anon,authenticated;
grant execute on function public.read_my_high_rollers_invitation(),public.respond_high_rollers_invitation(boolean,text) to authenticated;
do $$ declare source text; begin
 source:=pg_get_functiondef('public.can_view_raffles()'::regprocedure);
 execute replace(source,'m.player_id=p.kol_player_id','m.player_id=p.kol_player_id and m.status=''accepted''');
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 if strpos(source,'where m.player_id=sid and not')=0 then raise exception 'Unexpected membership guard'; end if;
 execute replace(source,'where m.player_id=sid and not','where m.player_id=sid and m.status=''accepted'' and not');
 source:=pg_get_functiondef('public.read_high_rollers_members(text,integer)'::regprocedure);
 execute replace(source,'m.player_id::text player_id,','m.player_id::text player_id,m.status,');
end $$;
notify pgrst,'reload schema';
commit;
