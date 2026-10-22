-- Apply after 069, then deploy the website. No bot rebuild/restart is needed.
-- Existing durations and deadlines are unchanged; 14 days is 336 hours.
begin;
alter table public.auctions drop constraint auctions_duration_hours_check;
alter table public.auctions add constraint auctions_duration_hours_check
    check (duration_hours in (6,12,24,72,168,336,720));

-- Preserve current catalog, identity, fee and escrow-limit checks in creation.
do $$
declare definition text;
    old_durations text:='p_duration_hours not in (6,12,24,72,168,720)';
begin
    definition:=pg_get_functiondef('public.create_auction(text,bigint,bigint,integer,text,bigint,integer,boolean)'::regprocedure);
    if strpos(definition,old_durations)=0 then raise exception 'Unexpected auction-duration validation; migration not applied.'; end if;
    execute replace(definition,old_durations,'p_duration_hours not in (6,12,24,72,168,336,720)');
end; $$;
notify pgrst,'reload schema';
commit;
