-- Apply after 209. Same complete-scan barrier and 60-second grace as auctions.
begin;
select pg_advisory_xact_lock(3888760);
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:='and clock_timestamp()<r.ends_at and (p_mail->>''received_at'')::timestamptz<r.ends_at';
 if strpos(source,anchor)=0 then raise exception 'Unexpected raffle deadline definition'; end if;
 source:=replace(source,anchor,'and (p_mail->>''received_at'')::timestamptz<r.ends_at');
 anchor:='n:=m/r.ticket_price;';
 if strpos(source,anchor)=0 then raise exception 'Unexpected ticket acceptance definition'; end if;
 source:=replace(source,anchor,$guard$
 if coalesce(case when p_mail->'raw' ? 'gift_original' then p_mail#>>'{raw,gift_original,azunixtime}' else p_mail#>>'{raw,azunixtime}' end,'') !~ '^[0-9]{1,12}$'
 or to_timestamp((case when p_mail->'raw' ? 'gift_original' then p_mail#>>'{raw,gift_original,azunixtime}' else p_mail#>>'{raw,azunixtime}' end)::bigint) is distinct from (p_mail->>'received_at')::timestamptz
 or (p_mail->>'received_at')::timestamptz>clock_timestamp()+interval '5 seconds' then raise exception 'Invalid KoL raffle timestamp; retain for review'; end if;
 n:=m/r.ticket_price;
$guard$);
 source:=replace(source,'ticket payments must be an exact multiple of the ticket price.','ticket payments must be an exact multiple of the ticket price and received before closing.');
 execute source;
 -- Reuse ordinary intake holds for every staged raffle message. A crash,
 -- isolation or disappearing KMail cannot silently drop it from the draw.
 source:=pg_get_functiondef('public.bot_stage_inbox_scan(uuid,jsonb)'::regprocedure);
 anchor:='for mail in select value from jsonb_array_elements(p_mails) loop';
 if strpos(source,anchor)=0 then raise exception 'Unexpected scan staging definition'; end if;
 execute replace(source,anchor,anchor||$stage$
 if mail#>>'{command,type}' in ('raffle','raffle_supply','raffle_advance')
 or (mail#>>'{command,type}'='gift_command_inside' and mail#>>'{command,intended}' in ('raffle','raffle_supply','supply')) then
  perform public.bot_isolate_raffle_intake(mail);
 end if;
$stage$);
 source:=pg_get_functiondef('public.bot_raffle_draw_work()'::regprocedure);
 anchor:='perform pg_advisory_xact_lock(3888760);';
 if strpos(source,anchor)=0 then raise exception 'Unexpected draw lock'; end if;
 source:=replace(source,anchor,anchor||$barrier$
 if khub_bot.raffle_intake_pending() then return '[]'::jsonb; end if;
 -- Only the most recent scan may authorize closing. Unfinished scans and
 -- incomplete reads cannot borrow authorization from an earlier scan.
 if not coalesce((select completed_at is not null and started_at>clock_timestamp()-interval '15 minutes'
 from khub_bot.inbox_scans order by started_at desc,id desc limit 1),false) then return '[]'::jsonb; end if;
$barrier$);
 anchor:='ends_at<=clock_timestamp() order by ends_at';
 if strpos(source,anchor)=0 then raise exception 'Unexpected draw selection'; end if;
 source:=replace(source,anchor,'ends_at+interval ''60 seconds''<=(select started_at from khub_bot.inbox_scans order by started_at desc,id desc limit 1) order by ends_at');
 execute source;
end $$;
notify pgrst,'reload schema';
commit;
