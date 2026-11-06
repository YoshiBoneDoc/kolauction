-- After 233. Statement-local read reuse; no transfer/concurrency changes.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
do $patch$
declare d text; anchor text;
begin
 -- History has up to fifty rows. Resolve stable viewer flags once, retaining
 -- all existing authorization, winner markers, cursors and admin evidence.
 d:=pg_get_functiondef('public.read_auction_bid_history(uuid,bigint,uuid,bigint)'::regprocedure);
 if strpos(d,'with authorized as materialized (')=0
 or strpos(d,'khub_bot.can_view_usernames()')=0 then raise exception 'Unexpected history definition'; end if;
 d:=replace(d,'khub_bot.is_administrator(auth.uid())','(select admin from viewer_flags)');
 d:=replace(d,'khub_bot.can_view_usernames()','(select names from viewer_flags)');
 d:=replace(d,'with authorized as materialized (',
 'with viewer_flags as materialized (select khub_bot.is_administrator(auth.uid()) as admin,khub_bot.can_view_usernames() as names), authorized as materialized (');
 execute d;
 -- A scoped gift-state read must retain all unresolved evidence. Build a set
 -- of IDs instead of executing correlated OR branches for every historical gift.
 d:=pg_get_functiondef('public.bot_gift_intake_state_scoped(text[])'::regprocedure);
 anchor:=$old$from khub_bot.incoming_gifts g where g.mail_id=any(p_ids)
 or (not g.legacy_donation and (g.payload is null or not exists(select 1 from khub_bot.receipts r where r.mail_id=g.mail_id)))
 or exists(select 1 from khub_bot.gift_open_attempts a where a.state in ('opening','isolated') and (a.mail_id=g.mail_id or a.before_state->>'requested_mail_id'=g.mail_id))
 or exists(select 1 from khub_bot.gift_mail_reviews r where r.mail_id=g.mail_id and r.resolved_at is null)$old$;
 if strpos(d,anchor)=0 then raise exception 'Unexpected scoped gift source'; end if;
 d:=replace(d,anchor,$new$from khub_bot.incoming_gifts g join (
 select mail_id from khub_bot.incoming_gifts where mail_id=any(p_ids)
 union
 select u.mail_id from khub_bot.incoming_gifts u left join khub_bot.receipts r on r.mail_id=u.mail_id
 where not u.legacy_donation and (u.payload is null or r.mail_id is null)
 union
 select mail_id from khub_bot.gift_open_attempts where state in ('opening','isolated')
 union
 select before_state->>'requested_mail_id' from khub_bot.gift_open_attempts where state in ('opening','isolated')
 union
 select mail_id from khub_bot.gift_mail_reviews where resolved_at is null
 ) wanted on wanted.mail_id=g.mail_id$new$);
 execute d;
 -- Keep the financial lock and all preexisting opening/recovery barriers.
 -- With no unopened envelope there is no claim and no solvency authority to
 -- return. Every actual candidate still computes fresh liabilities unchanged.
 d:=pg_get_functiondef('public.bot_claim_gift_open(jsonb)'::regprocedure);
 anchor:='b:=khub_bot.add_raffle_intake_holds(khub_bot.liabilities_before_gift_isolation());';
 if strpos(d,anchor)=0 then raise exception 'Unexpected gift claim liability base'; end if;
 execute replace(d,anchor,'if not exists(select 1 from khub_bot.incoming_gifts where payload is null) then return null; end if;'||chr(10)||anchor);
end $patch$;
notify pgrst,'reload schema';
commit;
