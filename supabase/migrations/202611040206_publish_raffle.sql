-- Apply after 205. Save and activate atomically; retries retain the request UUID.
begin;
create function public.publish_mystery_raffle(p_request_id uuid,p_name text,p_ticket_price bigint,p_ends_at timestamptz,p_prizes jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare rid uuid;
begin
 rid:=public.create_mystery_raffle(p_request_id,p_name,p_ticket_price,p_ends_at,p_prizes);
 if exists(select 1 from public.mystery_raffles where id=rid and state='preview') then
  perform public.activate_mystery_raffle(rid);
 end if;
 return rid;
end $$;
revoke all on function public.publish_mystery_raffle(uuid,text,bigint,timestamptz,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.publish_mystery_raffle(uuid,text,bigint,timestamptz,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
