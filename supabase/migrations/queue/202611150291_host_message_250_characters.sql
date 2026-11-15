-- Apply once after 288. Website deployment separately; no bot restart.
-- Shorten any existing longer host messages to 250 characters.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare source text;
begin
 source:=pg_get_functiondef('public.create_listing_with_message(jsonb)'::regprocedure);
 if strpos(source,'if char_length(msg) > 500 then')=0 then
  raise exception 'Unexpected host message creator; inspect installed definition';
 end if;
 source:=replace(source,'if char_length(msg) > 500 then','if char_length(msg) > 250 then');
 source:=replace(source,'Host message must be 500 characters or fewer.','Host message must be 250 characters or fewer.');
 execute source;
end $patch$;
update public.auctions set host_message=left(host_message,250) where char_length(host_message)>250;
update khub_bot.barter_auctions set host_message=left(host_message,250) where char_length(host_message)>250;
alter table public.auctions drop constraint auctions_host_message_check;
alter table public.auctions add constraint auctions_host_message_check
 check (char_length(host_message) <= 250);
alter table khub_bot.barter_auctions drop constraint barter_auctions_host_message_check;
alter table khub_bot.barter_auctions add constraint barter_auctions_host_message_check
 check (char_length(host_message) <= 250);
notify pgrst,'reload schema';
commit;
