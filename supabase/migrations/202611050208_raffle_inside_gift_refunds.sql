-- Apply after 207. Verified misplaced raffle commands are rejected/refunded,
-- never executed. Original gift proof and ordinary refund handling stay intact.
begin;
do $$ declare source text; anchor text;
begin
 source:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
 anchor:='not in (''list'',''bid'',''bid_help'',''buy'',''fund'',''fill'')';
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then
  raise exception 'Unexpected inside-gift intent validation';
 end if;
 execute replace(source,anchor,'not in (''list'',''bid'',''bid_help'',''buy'',''fund'',''fill'',''raffle'',''raffle_supply'',''supply'')');
 source:=pg_get_functiondef('khub_bot.friendly_reason(text)'::regprocedure);
 anchor:='else khub_bot.friendly_reason_before_inside_gift_commands(p_reason)';
 if strpos(source,anchor)=0 then raise exception 'Unexpected gift refund wording'; end if;
 execute replace(source,anchor,$body$
 when 'Gift command is inside: raffle' then 'Your raffle command was inside the gift package. Put RAFFLE and the raffle number in the outside message. The contents are being returned; no tickets were purchased.'
 when 'Gift command is inside: raffle_supply' then 'Your prize deposit command was inside the gift package. Put SUPPLY and the raffle number in the outside message. The contents are being returned; no deposit was accepted.'
 when 'Gift command is inside: supply' then 'Your prize deposit command was inside the gift package. Put SUPPLY and the raffle number in the outside message. The contents are being returned; no deposit was accepted.'
 else khub_bot.friendly_reason_before_inside_gift_commands(p_reason)
$body$);
end $$;
notify pgrst,'reload schema';
commit;
