-- After 271. Financial eligibility accompanies private leaderboard reads.
-- Preserve identity/ignore privacy; hidden players do not improve financial ranks.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare d text;anchor text;replacement text;
begin
 d:=pg_get_functiondef('public.read_leaderboards_before_personal()'::regprocedure);
 anchor:=E'       and not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1\n         where (i.user_id=$1 and i.kol_player_id=p.kol_player_id) or (i.user_id=p.id and i.kol_player_id=viewer.kol_player_id))';
 if strpos(d,anchor)=0 then raise exception 'Leaderboard privacy anchor missing';end if;
 d:=replace(d,anchor,'');
 anchor:=') ranked';
 replacement:=E') ranked where not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1\n where (i.user_id=$1 and i.kol_player_id=(select kol_player_id from public.profiles where id=ranked.id)) or (i.user_id=ranked.id and i.kol_player_id=viewer.kol_player_id))';
 if strpos(d,anchor)=0 then raise exception 'Leaderboard rank anchor missing';end if;
 execute replace(d,anchor,replacement);
 d:=pg_get_functiondef('public.search_leaderboards(text,text,integer)'::regprocedure);
 anchor:=E'   and not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1\n     where (i.user_id=$1 and i.kol_player_id=p.kol_player_id) or (i.user_id=p.id and i.kol_player_id=viewer.kol_player_id))';
 if strpos(d,anchor)=0 then raise exception 'Search privacy anchor missing';end if;
 d:=replace(d,anchor,'');
 anchor:='where strpos(lower(name),lower(btrim($2)))>0';
 replacement:=anchor||' and not exists(select 1 from public.player_ignores i join public.profiles viewer on viewer.id=$1 where (i.user_id=$1 and i.kol_player_id=(select kol_player_id from public.profiles where id=ranked.id)) or (i.user_id=ranked.id and i.kol_player_id=viewer.kol_player_id))';
 if strpos(d,anchor)=0 then raise exception 'Search match anchor missing';end if;
 execute replace(d,anchor,replacement);
end;$patch$;
alter function public.read_leaderboards() rename to read_leaderboards_before_fee_terms;
revoke all on function public.read_leaderboards_before_fee_terms() from public,anon,authenticated,service_role;
create function public.read_leaderboards() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;begin
 result:=public.read_leaderboards_before_fee_terms();
 return result||jsonb_build_object('fee_eligibility',khub_bot.fee_eligibility(auth.uid()));
end;$$;
revoke all on function public.read_leaderboards() from public,anon,authenticated,service_role;
grant execute on function public.read_leaderboards() to authenticated;
-- Future Buy funding messages describe the conservative locked reserve. Frozen,
-- sent and uncertain delivery bodies remain untouched by the existing renderer.
do $$declare d text;anchor text:='The reserve uses the standard commission rate, but promotional discounts may reduce your actual fees. Any unused reserve is refunded.';
begin
 d:=pg_get_functiondef('khub_bot.message_before_bundles(khub_bot.deliveries)'::regprocedure);
 if strpos(d,anchor)=0 then raise exception 'Buy reserve wording anchor missing';end if;
 d:=replace(d,anchor,'The reserve safely covers partial fulfillments under your locked fee terms. Actual discounts may reduce your fees. Any unused reserve is refunded.');
 anchor:='case when a.fee_policy=''tiered_v1'' then ''Tiered Fee'' else ''Fee'' end';
 if strpos(d,anchor)=0 then raise exception 'Sell fee label anchor missing';end if;
 execute replace(d,anchor,'case when a.fee_policy=''tiered_v1'' and not exists(select 1 from khub_bot.auction_fee_terms where auction_id=a.id) then ''Tiered Fee'' else ''Fee'' end');
end;$$;
notify pgrst,'reload schema';
commit;
