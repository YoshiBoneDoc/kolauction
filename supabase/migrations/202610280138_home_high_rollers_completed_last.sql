-- Apply after 126. Homepage High Rollers selects active listings before completed
-- trades BEFORE the 24-row limit. Other homepage sections and All Auctions stay unchanged.
begin;
do $patch$
declare definition text;
    projection text:='select a.id,khub_bot.high_roller_value(a) as value,';
    ordering text:='order by soon desc,case when soon then deadline end,value desc,id';
begin
    definition:=pg_get_functiondef('public.read_home_auctions()'::regprocedure);
    if strpos(definition,'high_rollers_active_first_v1')=0 then
        if strpos(definition,projection)=0
            or (length(definition)-length(replace(definition,ordering,'')))/length(ordering)<>2 then
            raise exception 'Unexpected homepage High Rollers projection; inspect before applying 138.';
        end if;
        definition:=replace(definition,projection,
            '/* high_rollers_active_first_v1 */ select a.id,(a.status=''completed'') as completed,khub_bot.high_roller_value(a) as value,');
        definition:=replace(definition,ordering,
            'order by completed asc,soon desc,case when soon then deadline end,value desc,id');
        execute definition;
    end if;
end; $patch$;
notify pgrst,'reload schema';
commit;
