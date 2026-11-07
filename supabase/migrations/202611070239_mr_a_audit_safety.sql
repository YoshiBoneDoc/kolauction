-- Apply after 238 with the sole worker stopped. Does not enable mixed Escrow.
-- Preserve original gift identity, balance proof, locks and replay protections.
begin;
select pg_advisory_xact_lock(3888760);
do $$ declare d text; anchor text;
begin
 d:=pg_get_functiondef('public.bot_finish_gift_open(uuid,jsonb,jsonb)'::regprocedure);
 anchor:='(v->>''quantity'')::bigint not between 1 and 5000000000';
 if strpos(d,anchor)=0 then raise exception 'Unexpected gift item proof validator'; end if;
 execute replace(d,anchor,'(v->>''quantity'')::numeric not between 1 and case when (v->>''id'')::integer=194 then 9007199254740991 else 5000000000 end');
 -- An absent configuration row must never authorize new mixed escrow listings.
 d:=pg_get_functiondef('public.create_mr_a_auction(jsonb,bigint)'::regprocedure);
 anchor:='if not (select enabled from khub_bot.mr_a_escrow_config where id) then';
 if strpos(d,anchor)=0 then raise exception 'Unexpected Mr. A activation guard'; end if;
 execute replace(d,anchor,'if not coalesce((select enabled from khub_bot.mr_a_escrow_config where id),false) then');
 d:=pg_get_functiondef('public.set_mr_a_escrow_enabled(boolean)'::regprocedure);
 anchor:='update khub_bot.mr_a_escrow_config set enabled=p_enabled where id;';
 if strpos(d,anchor)=0 then raise exception 'Unexpected Mr. A activation setter'; end if;
 execute replace(d,anchor,anchor||' if not found then raise exception ''Mr. A escrow configuration is missing; repair before activation.''; end if;');
end; $$;
notify pgrst,'reload schema';
commit;
