-- Apply after 164. Filter the underlying homepage selector, not just its wrapper.
-- Ranking, section limits and active totals must all see the same visible set.
begin;
set local lock_timeout = '2s';

do $patch$
declare
    definition text := pg_get_functiondef('public.read_home_auctions_before_site_totals()'::regprocedure);
    patched text;
begin
    patched := replace(definition, 'from public.auctions a', 'from khub_bot.visible_auctions() a');
    patched := replace(patched, 'join public.auctions a', 'join khub_bot.visible_auctions() a');
    if patched = definition and strpos(definition, 'khub_bot.visible_auctions() a') = 0 then
        raise exception 'Unexpected homepage selector; inspect before applying homepage ignore visibility.';
    end if;
    if patched <> definition then execute patched; end if;
end;
$patch$;

-- The helper remains private. Anonymous shared snapshots still have no viewer
-- ignore relationships; affected signed-in viewers use the private read path.
revoke all on function public.read_home_auctions_before_site_totals() from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
