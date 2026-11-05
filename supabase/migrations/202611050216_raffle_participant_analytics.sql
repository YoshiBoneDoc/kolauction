-- Apply after 215. Admin-only display data; no financial writes.
begin;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.read_admin_raffle_analytics(integer)'::regprocedure);
 anchor:='select player_id,count(*) raffles,sum(tickets) tickets from purchases group by player_id';
 if strpos(source,anchor)=0 then raise exception 'Unexpected people aggregate'; end if;
 source:=replace(source,anchor,'select player_id,count(*) raffles,sum(tickets) tickets,sum(revenue) revenue from purchases group by player_id');
 anchor:='username,s.raffles::text,s.tickets::text';
 if strpos(source,anchor)=0 then raise exception 'Unexpected people projection'; end if;
 source:=replace(source,anchor,anchor||',s.revenue::text');
 anchor:=$old$'current',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select $old$;
 if strpos(source,anchor)=0 then raise exception 'Unexpected current raffle projection'; end if;
 source:=replace(source,anchor,anchor||$new$
    coalesce((select jsonb_agg(to_jsonb(first_page) order by first_page.sort_tickets desc,first_page.player_id) from (
     select s.player_id::text,p.id profile_id,coalesce(p.kol_player_name,'Player #'||s.player_id) username,
      s.tickets::text tickets,s.tickets sort_tickets
     from purchases s left join public.profiles p on p.kol_player_id=s.player_id
     where s.raffle_id=r.id order by s.tickets desc,s.player_id limit 50
    ) first_page),'[]'::jsonb) participants_page,
$new$);
 execute source;
end $$;
notify pgrst,'reload schema';
commit;
