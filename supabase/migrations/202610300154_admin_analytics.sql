-- Administrator-only aggregate analytics. Last month is a rolling calendar month.
begin;
create or replace function public.read_admin_analytics() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; cutoff timestamptz := statement_timestamp() - interval '1 month';
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    with users as (
        select count(*)::text total, count(*) filter (where created_at >= cutoff)::text as month_total
        from public.profiles
    ), income as (
        -- Count each ledger entry once, including split transfers and Buy fees.
        -- Movement to the closet does not change earned income; cancelled entries do not count.
        select source, coalesce(sum(meat),0)::text total,
            coalesce(sum(meat) filter (where created_at >= cutoff),0)::text as month_total
        from khub_bot.closet_transfers
        where source in ('sale_fee','donation') and state <> 'cancelled'
        group by source
    )
    select jsonb_build_object(
        'generated_at',statement_timestamp(), 'month_since',cutoff,
        'users',(select jsonb_build_object('total',total,'month',month_total) from users),
        'sales',coalesce((select jsonb_build_object('total',total,'month',month_total) from income where source='sale_fee'),jsonb_build_object('total','0','month','0')),
        'donations',coalesce((select jsonb_build_object('total',total,'month',month_total) from income where source='donation'),jsonb_build_object('total','0','month','0'))
    ) into result;
    return result;
end; $$;
revoke all on function public.read_admin_analytics() from public,anon,authenticated;
grant execute on function public.read_admin_analytics() to authenticated;
notify pgrst,'reload schema';
commit;
