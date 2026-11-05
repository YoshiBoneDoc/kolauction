-- Apply after 214. Purchase-level history is private to administrators.
begin;
create function public.read_admin_raffle_ticket_history(p_id uuid,p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(khub_bot.is_administrator(auth.uid()),false) then raise exception 'Administrator required'; end if;
 if p_offset is null or p_offset<0 then raise exception 'Invalid offset'; end if;
 return coalesce((select jsonb_agg(to_jsonb(t) order by t.received_at desc,t.receipt_id desc) from (
  select rp.receipt_id,rp.player_id::text,p.id profile_id,
   coalesce(p.kol_player_name,'Player #'||rp.player_id) username,
   (rp.last_ticket-rp.first_ticket+1)::text ticket_count,rp.meat::text,rp.received_at
  from khub_bot.raffle_purchases rp left join public.profiles p on p.kol_player_id=rp.player_id
  where rp.raffle_id=p_id order by rp.received_at desc,rp.receipt_id desc limit 50 offset p_offset
 ) t),'[]'::jsonb);
end $$;
revoke all on function public.read_admin_raffle_ticket_history(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.read_admin_raffle_ticket_history(uuid,integer) to authenticated;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.read_raffle_management(uuid)'::regprocedure);
 anchor:=$old$'revenue',coalesce(a.revenue,0)::text,$old$;
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected raffle management definition'; end if;
 execute replace(source,anchor,anchor||$new$'ticket_count',coalesce(a.ticket_count,0)::text,$new$);
end $$;
notify pgrst,'reload schema';
commit;
