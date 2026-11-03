-- Apply after 189. Display/read correction only; no balances, cohort flags,
-- historical commissions or frozen delivery bodies are changed.
begin;
create or replace function public.admin_escrow_promotion(p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    -- Status is advisory and read-only. Only the setter takes the financial lock.
    if p_enabled is not null then perform public.set_escrow_promotion(p_enabled); end if;
    return jsonb_build_object('enabled',(select enabled from khub_bot.escrow_promotion_config where id));
end; $$;
revoke all on function public.admin_escrow_promotion(boolean) from public,anon,authenticated,service_role;
grant execute on function public.admin_escrow_promotion(boolean) to authenticated;

do $$
declare d text;
    old text := $old$||E'\nEstimated Tiered Fee ('||khub_bot.effective_fee_percent(fee,basis)||'): '||khub_bot.format_message_number(fee)||' Meat'$old$;
    replacement text := $new$||E'\nFees are determined separately for each completed fulfillment using the fee policy and eligibility at settlement. The original-rate reserve below is held for safe reversal of the promotion, not a quote of actual fees.'$new$;
begin
    d:=pg_get_functiondef('khub_bot.message_before_bundles(khub_bot.deliveries)'::regprocedure);
    if strpos(d,old)=0 then raise exception 'Buy funding fee description anchor missing'; end if;
    execute replace(d,old,replacement);
end; $$;
notify pgrst,'reload schema';
commit;
