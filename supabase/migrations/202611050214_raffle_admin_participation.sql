-- Apply after 213. Keep receipt deduplication, intake proof and financial locks intact.
begin;
select pg_advisory_xact_lock(3888760);
grant select(creator_id) on public.mystery_raffles to authenticated;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:=$old$if a.raffle_id is not null and p_mail#>>'{command,type}'='raffle' and r.state='active'$old$;
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected raffle purchase definition'; end if;
 execute replace(source,anchor,anchor||$guard$
 and sid<>a.admin_player_id
 and not exists(select 1 from public.profiles p where p.kol_player_id=sid
  and (p.id=r.creator_id or khub_bot.is_administrator(p.id)))
$guard$);
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:=$old$case when p_mail#>>'{command,type}'='raffle_supply' and m>0 then$old$;
 if strpos(source,anchor)=0 then raise exception 'Unexpected raffle refund definition'; end if;
 execute replace(source,anchor,$new$case when p_mail#>>'{command,type}'='raffle' and
 (sid=a.admin_player_id or exists(select 1 from public.profiles p where p.kol_player_id=sid
 and (p.id=r.creator_id or khub_bot.is_administrator(p.id))))
 then 'Raffle hosts and administrators cannot buy tickets. No tickets were issued. Any attached Meat or items are included with this refund.'
 when p_mail#>>'{command,type}'='raffle_supply' and m>0 then$new$);
end $$;
notify pgrst,'reload schema';
commit;
