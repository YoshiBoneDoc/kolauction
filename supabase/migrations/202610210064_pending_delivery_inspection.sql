-- Apply after 063. Read-only diagnostics for message preparation failures.
begin;
alter function public.bot_inspect() set schema khub_bot;
alter function khub_bot.bot_inspect() rename to inspect_before_pending_delivery_checks;
create function public.bot_inspect() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare
    report jsonb; d khub_bot.deliveries%rowtype; head_id uuid;
    problems jsonb:='[]'::jsonb; checked bigint:=0; body text;
    failure text; failure_code text; head_blocked boolean:=false;
begin
    report:=khub_bot.inspect_before_pending_delivery_checks();
    select id into head_id from khub_bot.deliveries where state='pending' order by created_at,id limit 1;
    for d in select * from khub_bot.deliveries where state='pending' order by created_at,id
    loop
        checked:=checked+1;
        failure:=null; failure_code:=null;
        begin
            -- Match the sender: saved bodies are frozen and need no reformatting.
            body:=coalesce(d.display_message,khub_bot.friendly_message(d));
            if body is null or btrim(body)='' then
                failure:='Delivery message is empty; inspect this delivery before sending.';
                failure_code:='empty_message';
            end if;
        exception when others then
            failure_code:=sqlstate;
            -- Never print arbitrary exception text, message bodies, passwords or
            -- request payloads. These two formatter errors contain no user data.
            failure:=case sqlerrm
                when 'Unrecognized delivery template; inspect delivery before sending.' then 'Unrecognized delivery template; inspect delivery before sending.'
                when 'Accepted bid amount missing; inspect delivery before sending.' then 'Accepted bid amount missing; inspect delivery before sending.'
                else 'Delivery message preparation failed; inspect this delivery before sending.' end;
        end;
        if failure is not null then
            head_blocked:=head_blocked or d.id=head_id;
            problems:=problems||jsonb_build_array(jsonb_build_object(
                'id',d.id,'delivery_reference','D-'||d.reference_number,
                'kind',d.kind,'created_at',d.created_at,'blocksQueue',d.id=head_id,
                'error_code',failure_code,'reason',failure));
        end if;
    end loop;
    return report||jsonb_build_object(
        'pendingDeliveryChecks',checked,'pendingDeliveryAttention',problems,
        'pendingQueueBlocked',head_blocked);
end; $$;
revoke all on function khub_bot.inspect_before_pending_delivery_checks() from public,anon,authenticated,service_role;
revoke all on function public.bot_inspect() from public,anon,authenticated;
grant execute on function public.bot_inspect() to service_role;
notify pgrst,'reload schema';
commit;
