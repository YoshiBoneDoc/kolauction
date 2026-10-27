-- Apply once after 119, before updating the bot. No historical receipts or
-- donations are reclassified. New misplaced commands use existing refund,
-- deduplication, gift-proof, delivery and financial-lock safeguards.
begin;
select pg_advisory_xact_lock(3888760);

-- Change only rejection selection inside the existing validated intake path.
-- No inside command is ever executed or attached to an auction/reservation.
do $patch$
declare definition text; anchor text := 'if cmd=''verify'' then';
begin
    definition:=pg_get_functiondef('khub_bot.ingest_mail_before_invalid_refunds(jsonb)'::regprocedure);
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
        raise exception 'Unexpected escrow intake definition; review before applying inside-command returns.';
    end if;
    definition:=replace(definition,anchor,$code$
    if cmd='gift_command_inside' then
        if p_mail#>>'{command,intended}' is null
            or p_mail#>>'{command,intended}' not in ('list','bid','bid_help','buy','fund','fill')
            or not exists(select 1 from khub_bot.incoming_gifts g
                where g.mail_id=mid and g.payload=p_mail and not g.legacy_donation) then
            raise exception 'Misplaced gift command requires verified gift contents and a supported intent.';
        end if;
        reason:='Gift command is inside: '||(p_mail#>>'{command,intended}');
    elsif cmd='verify' then
$code$);
    execute definition;
end; $patch$;

-- Existing rejected-delivery templates already add the return explanation and
-- freeze the message on first claim. Keep that behavior and translate only the
-- six fixed reasons introduced above; never echo private inside-note text.
alter function khub_bot.friendly_reason(text) rename to friendly_reason_before_inside_gift_commands;
revoke all on function khub_bot.friendly_reason_before_inside_gift_commands(text) from public,anon,authenticated,service_role;
create function khub_bot.friendly_reason(p_reason text) returns text
language sql immutable set search_path='' as $$
    select case p_reason
        when 'Gift command is inside: list' then 'It looks like you were trying to deposit items for a Sell auction, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        when 'Gift command is inside: bid' then 'It looks like you were trying to place a bid, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        when 'Gift command is inside: bid_help' then 'It looks like you were trying to place a bid, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        when 'Gift command is inside: buy' then 'It looks like you were trying to buy an auction listing, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        when 'Gift command is inside: fund' then 'It looks like you were trying to fund a Buy auction, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        when 'Gift command is inside: fill' then 'It looks like you were trying to fulfill a Buy order, but the command was inside your gift package. Please copy the exact command from the auction page into the package''s outside message and try again.'
        else khub_bot.friendly_reason_before_inside_gift_commands(p_reason)
    end;
$$;
revoke all on function khub_bot.friendly_reason(text) from public,anon,authenticated,service_role;

notify pgrst,'reload schema';
commit;
