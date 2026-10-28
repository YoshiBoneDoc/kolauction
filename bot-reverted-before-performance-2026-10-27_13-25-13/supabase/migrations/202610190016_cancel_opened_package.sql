-- Normally apply after 015. Also compatible with 013/014 to resolve a wrapper
-- without changing mail policy. Stop all workers before cancelling a plan.
-- This migration adds the operation; it does not cancel any existing record.
begin;
alter table khub_bot.closet_transfers drop constraint closet_transfers_state_check;
alter table khub_bot.closet_transfers add constraint closet_transfers_state_check
    check (state in ('pending','moving','moved','unknown','cancelled'));
alter table khub_bot.closet_reconciliations drop constraint closet_reconciliations_resolution_check;
alter table khub_bot.closet_reconciliations add constraint closet_reconciliations_resolution_check
    check (resolution in ('moved','not-moved','cancelled'));

create function public.bot_cancel_opened_package(p_id uuid,p_evidence text) returns void
language plpgsql security definer set search_path='' as $$
declare d khub_bot.closet_transfers%rowtype;
begin
    perform pg_advisory_xact_lock(3888760);
    if length(btrim(coalesce(p_evidence,'')))<12 then
        raise exception 'Record why the gift package was opened before cancelling.';
    end if;
    select * into d from khub_bot.closet_transfers where id=p_id for update;
    if not found then raise exception 'Closet transfer not found.'; end if;
    if d.state<>'pending' or d.source<>'gift_package' or d.meat<>0
       or d.item_id not in (1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1460)
       or d.receipt_id is not null or d.auction_id is not null
       or d.attempt is not null or d.before_state is not null or d.moved_at is not null
       or exists(select 1 from khub_bot.closet_reconciliations where transfer_id=p_id) then
        raise exception 'Only never-attempted pending gift-package wrapper plans can be cancelled.';
    end if;
    update khub_bot.closet_transfers set state='cancelled',evidence=p_evidence where id=p_id;
    insert into khub_bot.closet_reconciliations(transfer_id,resolution,evidence)
        values(p_id,'cancelled',p_evidence);
end; $$;
revoke all on function public.bot_cancel_opened_package(uuid,text) from public,anon,authenticated;
grant execute on function public.bot_cancel_opened_package(uuid,text) to service_role;
notify pgrst,'reload schema';
commit;
