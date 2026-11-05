-- Apply after 206. Preserve original rejection receipts and refund obligations.
-- Only ordinary item-free KMail reclassified by the raffle parser is compatible.
begin;
create function khub_bot.rejected_raffle_replay(p_mail jsonb) returns boolean
language sql stable security definer set search_path='' as $$
 select exists (
  select 1 from khub_bot.receipts r
  where r.mail_id=p_mail->>'id'
   and r.payload->'command'='{"type":"unknown"}'::jsonb
   and r.result='Unknown command. Use VERIFY <code>, LIST <auction-id>, BID <auction-id>, or BUY <auction-id>.'
   and p_mail#>>'{command,type}' in ('raffle','raffle_supply','raffle_advance')
   and r.payload-'command'=p_mail-'command'
   and r.payload#>>'{raw,type}'='normal'
   and not (r.payload->'raw' ? 'gift_original')
   and r.payload->'items'='[]'::jsonb
   and exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id)
   and not exists(select 1 from khub_bot.deliveries d where d.receipt_id=r.mail_id
     and (d.kind<>'refund' or d.recipient_id<>r.sender_id or d.item_id is not null
          or d.quantity<>0 or d.state not in ('pending','sending','unknown','sent')))
   and (select sum(d.meat) from khub_bot.deliveries d where d.receipt_id=r.mail_id)=(r.payload->>'meat')::bigint
   and not exists(select 1 from khub_bot.raffle_purchases p where p.receipt_id=r.mail_id)
 );
$$;
revoke all on function khub_bot.rejected_raffle_replay(jsonb) from public,anon,authenticated,service_role;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:='if old.payload<>p_mail then raise exception ''Receipt payload conflict''; end if;';
 if strpos(source,anchor)=0 then raise exception 'Unexpected raffle intake definition'; end if;
 execute replace(source,anchor,'if old.payload<>p_mail and not khub_bot.rejected_raffle_replay(p_mail) then raise exception ''Receipt payload conflict''; end if;');
 source:=pg_get_functiondef('public.bot_handled_mail(jsonb)'::regprocedure);
 anchor:='r.payload=m';
 if strpos(source,anchor)=0 then raise exception 'Unexpected replay definition'; end if;
 execute replace(source,anchor,'(r.payload=m or khub_bot.rejected_raffle_replay(m))');
end $$;
notify pgrst,'reload schema';
commit;
