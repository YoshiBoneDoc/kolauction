-- Apply after 217. Display-only classification; never delete financial history.
begin;
alter table public.mystery_raffles add column is_test boolean not null default false;
grant select(is_test) on public.mystery_raffles to anon,authenticated;
-- No browser write grant: marking/unmarking is an explicit owner SQL operation.
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.read_admin_raffle_analytics(integer)'::regprocedure);
 anchor:='from khub_bot.raffle_purchases group by raffle_id,player_id';
 if strpos(source,anchor)=0 then raise exception 'Unexpected analytics purchases'; end if;
 source:=replace(source,anchor,'from khub_bot.raffle_purchases where raffle_id in (select id from public.mystery_raffles where not is_test) group by raffle_id,player_id');
 anchor:='from public.mystery_raffles r left join totals t on t.raffle_id=r.id';
 if strpos(source,anchor)=0 then raise exception 'Unexpected analytics raffles'; end if;
 source:=replace(source,anchor,'from (select * from public.mystery_raffles where not is_test) r left join totals t on t.raffle_id=r.id');
 execute source;
end $$;
notify pgrst,'reload schema';
commit;
