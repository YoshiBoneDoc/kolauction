-- Read-only display context for commission logs. Apply after 144.
-- No changes to claims, transfer amounts, retries, acknowledgment or safeguards.
begin;
alter function khub_bot.closet_transfer_details(khub_bot.closet_transfers) rename to closet_details_before_listing_context;
create function khub_bot.closet_transfer_details(c khub_bot.closet_transfers) returns jsonb
language sql stable set search_path='' as $$
    select khub_bot.closet_details_before_listing_context(c)||coalesce((
        select jsonb_build_object('auction_quantity',a.quantity::text,
            'auction_is_bundle',jsonb_array_length(a.bundle_items)>1,
            'auction_bundle_units',case when jsonb_array_length(a.bundle_items)>1 then (
                select sum((component.value->>'quantity')::numeric)::text from jsonb_array_elements(a.bundle_items) component(value)
            ) end)
        from public.auctions a where a.id=c.auction_id
    ),'{}'::jsonb);
$$;
revoke all on function khub_bot.closet_transfer_details(khub_bot.closet_transfers),khub_bot.closet_details_before_listing_context(khub_bot.closet_transfers)
    from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
