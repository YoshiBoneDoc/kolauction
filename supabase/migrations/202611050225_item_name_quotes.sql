-- Apply after 224. Display/search names only; no quantities, amounts or receipts change.
begin;
create function khub_bot.item_name_quotes(value text) returns text language sql immutable set search_path='' as $$
 select regexp_replace(regexp_replace(value,'&(quot|#0*34|#x0*22);','"','gi'),'&(apos|#0*39|#x0*27);',chr(39),'gi');
$$;
create function khub_bot.normalize_catalog_quotes() returns trigger language plpgsql set search_path='' as $$
begin new.name:=khub_bot.item_name_quotes(new.name);return new;end $$;
create trigger normalize_catalog_quotes before insert or update of name on khub_bot.catalog for each row execute function khub_bot.normalize_catalog_quotes();
create function khub_bot.normalize_auction_quotes() returns trigger language plpgsql set search_path='' as $$
begin
 new.item:=khub_bot.item_name_quotes(new.item);
 new.bundle_items:=coalesce((select jsonb_agg(case when component ? 'name' then jsonb_set(component,'{name}',to_jsonb(khub_bot.item_name_quotes(component->>'name'))) else component end order by ord) from jsonb_array_elements(new.bundle_items) with ordinality t(component,ord)),'[]'::jsonb);
 return new;
end $$;
create trigger normalize_auction_quotes before insert or update of item,bundle_items on public.auctions for each row execute function khub_bot.normalize_auction_quotes();
update khub_bot.catalog set name=khub_bot.item_name_quotes(name) where name is distinct from khub_bot.item_name_quotes(name);
update public.auctions set item=item where item is distinct from khub_bot.item_name_quotes(item) or bundle_items::text ~* '&(quot|apos|#0*34|#0*39|#x0*22|#x0*27);';
-- Refresh the versioned catalog payload, so existing browsers receive a new version.
update khub_bot.item_catalog_state set source_sha256=source_sha256;
revoke all on function khub_bot.item_name_quotes(text),khub_bot.normalize_catalog_quotes(),khub_bot.normalize_auction_quotes() from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
