-- Admin inbox control; reuse the settlement-serialized toggle from migration 187.
begin;
create function public.admin_escrow_promotion(p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    perform pg_advisory_xact_lock(3888760);
    if p_enabled is not null then
        perform public.set_escrow_promotion(p_enabled);
    end if;
    return jsonb_build_object('enabled',(select enabled from khub_bot.escrow_promotion_config where id));
end; $$;
revoke all on function public.admin_escrow_promotion(boolean) from public,anon,authenticated,service_role;
grant execute on function public.admin_escrow_promotion(boolean) to authenticated;
notify pgrst,'reload schema';
commit;
