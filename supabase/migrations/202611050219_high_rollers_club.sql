-- Apply after 218. Replaces temporary named-test access; no members are seeded.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.high_rollers_members (
 player_id bigint primary key check(player_id>0),
 added_at timestamptz not null default clock_timestamp(),
 added_by uuid not null references public.profiles(id)
);
alter table khub_bot.high_rollers_members enable row level security;
revoke all on khub_bot.high_rollers_members from public,anon,authenticated,service_role;
create or replace function public.can_view_raffles() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.profiles p where p.id=auth.uid()
 and not khub_bot.profile_is_restricted(p.id)
 and (khub_bot.is_administrator(p.id) or exists(
 select 1 from khub_bot.high_rollers_members m where m.player_id=p.kol_player_id)));
$$;
create function public.read_high_rollers_members(p_search text default '',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required' using errcode='42501'; end if;
 return jsonb_build_object('total',(select count(*) from khub_bot.high_rollers_members),
 'members',coalesce((select jsonb_agg(to_jsonb(x) order by lower(x.username),x.player_id) from (
 select m.player_id::text player_id,coalesce(p.kol_player_name,'Player #'||m.player_id) username
 from khub_bot.high_rollers_members m left join public.profiles p on p.kol_player_id=m.player_id
 where strpos(lower(coalesce(p.kol_player_name,'')),lower(trim(coalesce(p_search,''))))>0
 or strpos(m.player_id::text,trim(coalesce(p_search,'')))>0
 order by lower(coalesce(p.kol_player_name,'Player #'||m.player_id)),m.player_id
 limit 50 offset greatest(0,least(coalesce(p_offset,0),1000000))
 ) x),'[]'::jsonb));
end $$;
create function public.add_high_rollers_member(p_player text) returns void
language plpgsql security definer set search_path='' as $$
declare target bigint; matches integer;
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(3888760);
 select count(*),min(kol_player_id) into matches,target from public.profiles
 where kol_player_id>0 and (kol_player_id::text=trim(p_player) or lower(kol_player_name)=lower(trim(p_player)));
 if matches<>1 then raise exception 'Enter an exact KoL username or player ID for a registered kHub player.'; end if;
 insert into khub_bot.high_rollers_members(player_id,added_by) values(target,auth.uid()) on conflict do nothing;
end $$;
create function public.remove_high_rollers_member(p_player_id text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required' using errcode='42501'; end if;
 perform pg_advisory_xact_lock(3888760);
 delete from khub_bot.high_rollers_members where player_id::text=p_player_id;
end $$;
revoke all on function public.read_high_rollers_members(text,integer),public.add_high_rollers_member(text),public.remove_high_rollers_member(text) from public,anon,authenticated;
grant execute on function public.read_high_rollers_members(text,integer),public.add_high_rollers_member(text),public.remove_high_rollers_member(text) to authenticated;
-- Keep the existing receipt, refund, gift-proof and administrator purchase guards.
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:=$old$if a.raffle_id is not null and p_mail#>>'{command,type}'='raffle' and r.state='active'$old$;
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected raffle purchase definition'; end if;
 execute replace(source,anchor,anchor||$guard$
 and exists(select 1 from khub_bot.high_rollers_members m join public.profiles p on p.kol_player_id=m.player_id
 where m.player_id=sid and not khub_bot.profile_is_restricted(p.id))
$guard$);
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:=$old$when p_mail#>>'{command,type}'='raffle_supply' and m>0 then$old$;
 if strpos(source,anchor)=0 then raise exception 'Unexpected raffle refund definition'; end if;
 execute replace(source,anchor,$new$when p_mail#>>'{command,type}'='raffle' and not exists(
 select 1 from khub_bot.high_rollers_members m join public.profiles p on p.kol_player_id=m.player_id
 where m.player_id=sid and not khub_bot.profile_is_restricted(p.id))
 then 'You have no business typing that command. You''re lucky im returning your items and meat.'
 when p_mail#>>'{command,type}'='raffle_supply' and m>0 then$new$);
end $$;
notify pgrst,'reload schema';
commit;
