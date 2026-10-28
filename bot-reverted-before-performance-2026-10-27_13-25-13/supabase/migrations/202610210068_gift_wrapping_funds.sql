-- Apply after 067 before deploying the gift-fallback worker.
-- Gift wrapping uses spare operating Meat, including no pending closet plans.
begin;
create function public.bot_gift_wrapping_liabilities() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_set(held,'{meat}',to_jsonb(((held->>'meat')::numeric+coalesce((
        select sum(c.meat) from khub_bot.closet_transfers c
        where c.state in ('pending','moving','unknown')
    ),0))::text)) from (select public.bot_liabilities() held) protected;
$$;
revoke all on function public.bot_gift_wrapping_liabilities() from public,anon,authenticated;
grant execute on function public.bot_gift_wrapping_liabilities() to service_role;
notify pgrst,'reload schema';
commit;
