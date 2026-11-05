-- Apply after 203, then deploy website and matching bot runtime separately.
-- Temporary visibility restriction; remove in a later migration after owner approval.
begin;
create function public.can_view_raffles() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles where id=auth.uid() and
 (kol_player_id=3552305 or lower(kol_player_name) in ('anrath1','nisemono')));
$$;
revoke all on function public.can_view_raffles() from public,anon,authenticated;
grant execute on function public.can_view_raffles() to anon,authenticated;
alter policy raffle_preview_read on public.mystery_raffles using(public.can_view_raffles());
alter policy raffle_prize_preview_read on public.mystery_raffle_prizes using(public.can_view_raffles());
-- Remove only the development CHECK; retain the operational switch.
alter table khub_bot.raffle_gate drop constraint raffle_gate_enabled_check;
update khub_bot.raffle_gate set enabled=true where id;
do $$
declare source text;
begin
 source:=pg_get_functiondef('public.read_raffle_management(uuid)'::regprocedure);
 if strpos(source,'''activation_enabled'',false')=0 then raise exception 'Unexpected management function'; end if;
 execute replace(source,'''activation_enabled'',false','''activation_enabled'',coalesce((select enabled from khub_bot.raffle_gate where id),false)');
 source:=pg_get_functiondef('public.activate_mystery_raffle(uuid)'::regprocedure);
 execute replace(source,'Raffles remain preview-only pending lifecycle verification','Raffle activation is temporarily paused');
end $$;
notify pgrst,'reload schema';
commit;
