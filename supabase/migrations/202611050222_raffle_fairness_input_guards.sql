-- Apply after 221. No historical proof changes or financial obligation changes.
begin;
select pg_advisory_xact_lock(3888760);
create function khub_bot.guard_frozen_raffle_inputs() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from khub_bot.raffle_fairness where raffle_id=old.raffle_id)
 and (new.draw_input is distinct from old.draw_input or new.ticket_count is distinct from old.ticket_count
 or new.ticket_label_offset is distinct from old.ticket_label_offset or new.fair_required is distinct from old.fair_required) then
 raise exception 'Committed raffle inputs are immutable'; end if;
 return new;
end $$;
create trigger guard_frozen_raffle_inputs before update on khub_bot.raffle_accounts
 for each row execute function khub_bot.guard_frozen_raffle_inputs();
revoke all on function khub_bot.guard_frozen_raffle_inputs() from public,anon,authenticated,service_role;
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('public.bot_commit_raffle_draw(uuid,jsonb)'::regprocedure);
 anchor:='seed:=khub_bot.fair_hash(';
 if strpos(source,anchor)=0 then raise exception 'Unexpected fair draw function'; end if;
 source:=replace(source,anchor,$guard$
  if split_part(f.manifest,E'\n',2) is distinct from p_id::text
  or split_part(f.manifest,E'\n',3) is distinct from f.round::text
  or split_part(f.manifest,E'\n',4) is distinct from a.ticket_count::text
  or split_part(f.manifest,E'\n',5) is distinct from a.ticket_label_offset::text
  or split_part(f.manifest,E'\n',6) is distinct from khub_bot.fair_hash(a.draw_input::text)
  or khub_bot.fair_hash(f.manifest) is distinct from f.commitment_hash
  then raise exception 'Frozen inputs differ from commitment'; end if;
  $guard$||anchor);
 execute source;
end $$;
-- Rotate pending work: unavailable old rounds must not monopolize all five slots.
do $$ declare source text; anchor text; begin
 source:=pg_get_functiondef('khub_bot.draw_work_before_fairness()'::regprocedure);
 anchor:='select id from public.mystery_raffles where state=''drawing'' order by ends_at limit 5';
 if strpos(source,anchor)=0 then raise exception 'Unexpected draw queue'; end if;
 execute replace(source,anchor,'select mr.id from public.mystery_raffles mr join khub_bot.raffle_accounts ra on ra.raffle_id=mr.id where mr.state=''drawing'' order by ra.last_work_at,mr.ends_at,mr.id limit 5');
 source:=pg_get_functiondef('public.bot_raffle_draw_work()'::regprocedure);
 anchor:='output:=output||jsonb_build_array(entry);';
 if strpos(source,anchor)=0 then raise exception 'Unexpected fairness queue'; end if;
 execute replace(source,anchor,'update khub_bot.raffle_accounts set last_work_at=clock_timestamp() where raffle_id=(entry->>''raffleId'')::uuid; '||anchor);
end $$;
notify pgrst,'reload schema';
commit;
