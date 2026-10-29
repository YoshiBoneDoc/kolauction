-- Apply after 148. No transaction/claim/send/escrow rules are changed.
begin;
do $$ declare definition text; anchor text := '''account_method'',p.account_method,';
begin
    definition:=pg_get_functiondef('public.read_my_account_access()'::regprocedure);
    if strpos(definition,anchor)=0 then raise exception 'Unexpected private account reader; inspect before applying 149.'; end if;
    execute replace(definition,anchor,anchor||'''kol_player_id'',p.kol_player_id,''kol_player_name'',p.kol_player_name,');
end;$$;

-- These are hints to skip empty work, NEVER permission to send or a solvency
-- snapshot. Real claims, balances, reserve checks and acknowledgments stay live.
create function public.bot_read_work_queue() returns jsonb
language sql stable security definer set search_path='' as $$
    select jsonb_build_object('deliveries_pending',exists(select 1 from khub_bot.deliveries where state='pending'),
        'buy_groups',public.bot_pending_buy_delivery_groups());
$$;
create function public.bot_prepare_closet_queue(p_inventory jsonb,p_review_items jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
    perform public.bot_queue_gift_packages(p_inventory,p_review_items);
    return exists(select 1 from khub_bot.closet_transfers where state='pending');
end;$$;
create function public.bot_refresh_public_discovery() returns void
language sql security definer set search_path='' as $$ select khub_bot.refresh_public_discovery(); $$;
alter function public.bot_worker_status() set schema khub_bot;
alter function khub_bot.bot_worker_status() rename to worker_status_before_read_efficiency;
create function public.bot_worker_status() returns jsonb
language sql stable security definer set search_path='' as $$
    select khub_bot.worker_status_before_read_efficiency()||jsonb_build_object('readEfficiencyVersion',1);
$$;
revoke all on function khub_bot.worker_status_before_read_efficiency(),public.bot_worker_status(),public.bot_read_work_queue(),public.bot_prepare_closet_queue(jsonb,jsonb),public.bot_refresh_public_discovery() from public,anon,authenticated,service_role;
grant execute on function public.bot_worker_status(),public.bot_read_work_queue(),public.bot_prepare_closet_queue(jsonb,jsonb),public.bot_refresh_public_discovery() to service_role;
notify pgrst,'reload schema';
commit;
