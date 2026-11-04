-- After 191. Read-only optimization: evaluate seller restriction checks once per
-- distinct seller in the relevant read pool. No financial routines are changed.
begin;
set local lock_timeout='2s';
do $$
declare d text; patched text;
begin
 d:=pg_get_functiondef('public.read_home_auctions_before_site_totals()'::regprocedure);
 if strpos(d,'with active as materialized (')=0 or strpos(d,'not khub_bot.profile_is_restricted(a.seller_id)')=0 then
    raise exception 'Unexpected Home selector; inspect before applying'; end if;
 patched:=replace(d,'with active as materialized (',
 $patch$with seller_restrictions as materialized (
    select s.seller_id,khub_bot.profile_is_restricted(s.seller_id) as restricted
    from (select distinct a.seller_id from khub_bot.visible_auctions() a
        where a.status='active' and coalesce(a.escrow_buyout_received_at,a.end_time)>statement_timestamp()) s
 ), active as materialized ($patch$);
 patched:=replace(patched,'not khub_bot.profile_is_restricted(a.seller_id)',
    'not (select r.restricted from seller_restrictions r where r.seller_id=a.seller_id)');
 execute patched;
 d:=pg_get_functiondef('public.read_auction_card_context(uuid[])'::regprocedure);
 if strpos(d,'from khub_bot.visible_auctions() a')=0 or strpos(d,'return (select jsonb_build_object(')=0
    or strpos(d,'''bidding_restricted'',khub_bot.profile_is_restricted(a.seller_id)')=0 then
    raise exception 'Unexpected card context source'; end if;
 patched:=replace(d,'return (select jsonb_build_object(',
 $patch$return (with requested as materialized (
    select a.* from khub_bot.visible_auctions() a
    where a.id=any(p_ids) and a.status<>'pending_escrow' and not khub_bot.is_abandoned_escrow_draft(a)
 ), seller_restrictions as materialized (
    select s.seller_id,khub_bot.profile_is_restricted(s.seller_id) as restricted
    from (select distinct seller_id from requested where status='active' and auction_kind='sell') s
 ) select jsonb_build_object($patch$);
 -- Replace only the outer source; preserve the installed visibility helper above.
 patched:=replace(patched,E' from khub_bot.visible_auctions() a\n left join',E' from requested a\n left join');
 patched:=replace(patched,'''bidding_restricted'',khub_bot.profile_is_restricted(a.seller_id)',
    '''bidding_restricted'',(select r.restricted from seller_restrictions r where r.seller_id=a.seller_id)');
 if patched=d then raise exception 'Card optimization anchor missing'; end if;
 execute patched;
end; $$;
notify pgrst,'reload schema';
commit;
