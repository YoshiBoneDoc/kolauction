-- Apply after 212. Cosmetic private numbering only; draw ranges and odds unchanged.
-- Existing raffle accounts retain their previously issued numbers (offset zero).
begin;
select pg_advisory_xact_lock(3888760);
alter table khub_bot.raffle_accounts add column ticket_label_offset integer not null default 0
 check(ticket_label_offset=0 or ticket_label_offset between 999 and 9998);
alter table khub_bot.raffle_accounts alter column ticket_label_offset set default (999+floor(random()*9000))::integer;
create function khub_bot.freeze_raffle_ticket_labels() returns trigger language plpgsql set search_path='' as $$
begin
 if new.ticket_label_offset is distinct from old.ticket_label_offset then raise exception 'Raffle ticket numbering is immutable'; end if;
 return new;
end $$;
revoke all on function khub_bot.freeze_raffle_ticket_labels() from public,anon,authenticated,service_role;
create trigger freeze_raffle_ticket_labels before update of ticket_label_offset on khub_bot.raffle_accounts
for each row execute function khub_bot.freeze_raffle_ticket_labels();
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 anchor:=$old$'||(a.ticket_count+1)||' through '||(a.ticket_count+n)||'$old$;
 if (length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'Unexpected raffle ticket confirmation'; end if;
 execute replace(source,anchor,$new$'||(a.ticket_count::numeric+a.ticket_label_offset+1)||' through '||(a.ticket_count::numeric+a.ticket_label_offset+n)||'$new$);
 source:=pg_get_functiondef('public.read_my_raffle_tickets(uuid)'::regprocedure);
 anchor:='from khub_bot.raffle_purchases p where raffle_id=p_id';
 if strpos(source,anchor)=0 or strpos(source,'''first_ticket'',first_ticket::text')=0 or strpos(source,'''last_ticket'',last_ticket::text')=0 then raise exception 'Unexpected private ticket history'; end if;
 source:=replace(source,'''first_ticket'',first_ticket::text','''first_ticket'',(first_ticket::numeric+a.ticket_label_offset)::text');
 source:=replace(source,'''last_ticket'',last_ticket::text','''last_ticket'',(last_ticket::numeric+a.ticket_label_offset)::text');
 source:=replace(source,anchor,'from khub_bot.raffle_purchases p join khub_bot.raffle_accounts a on a.raffle_id=p.raffle_id where p.raffle_id=p_id');
 execute source;
end $$;
notify pgrst,'reload schema';
commit;
