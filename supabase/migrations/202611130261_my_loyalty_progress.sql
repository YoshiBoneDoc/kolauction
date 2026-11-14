-- After 260. Private display read only; no commissions or settlement rules change.
-- Apply once, then deploy the website. No bot/cache Worker deployment needed.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create function public.read_my_loyalty_progress() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
 if actor is null then raise exception 'Log in to view your sales progress.' using errcode='42501'; end if;
 if khub_bot.profile_is_restricted(actor) then raise exception 'This account is restricted.' using errcode='42501'; end if;
 -- Reuse the seller index and authoritative final sale value (including locked
 -- mixed-payment value). Buy orders, deposits, pending sales and Direct are excluded.
 return (select jsonb_build_object('completed_escrow_sales_meat',coalesce(sum(a.final_price::numeric),0)::text)
 from public.auctions a where a.seller_id=actor and a.auction_kind='sell'
 and a.escrow_mode and a.status='completed' and a.winner_id is not null and a.final_price>0);
end; $$;
revoke all on function public.read_my_loyalty_progress() from public,anon,authenticated,service_role;
grant execute on function public.read_my_loyalty_progress() to authenticated;
notify pgrst,'reload schema';
commit;
