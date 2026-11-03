-- After 178. Serialize reference data once per successful catalogue sync,
-- rather than once per browser. Reads below are indexed singleton lookups.
begin;
set local lock_timeout='2s';
create table khub_bot.public_item_catalog_snapshot (
 singleton boolean primary key default true check(singleton), version text not null, payload jsonb not null
);
revoke all on khub_bot.public_item_catalog_snapshot from public,anon,authenticated,service_role;
create function khub_bot.refresh_item_catalog_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$declare payload jsonb;begin
 payload:=public.read_item_catalog();
 if payload->>'ready'='true' then
   insert into khub_bot.public_item_catalog_snapshot values(true,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),payload)
   on conflict(singleton) do update set version=excluded.version,payload=excluded.payload;
 end if;
 return null;
end;$$;
revoke all on function khub_bot.refresh_item_catalog_snapshot() from public,anon,authenticated,service_role;
create trigger refresh_item_catalog_snapshot after insert or update of source_sha256 on khub_bot.item_catalog_state
for each row execute function khub_bot.refresh_item_catalog_snapshot();
-- Seed from the installed catalogue, if ready, without another source fetch.
insert into khub_bot.public_item_catalog_snapshot
 select true,encode(sha256(convert_to(payload::text,'UTF8')),'hex'),payload
 from (select public.read_item_catalog() as payload) s where payload->>'ready'='true';
create function public.read_item_catalog_manifest() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('version',version,'url','/api/item-catalog?version='||version) from khub_bot.public_item_catalog_snapshot where singleton;
$$;
create function public.read_item_catalog_snapshot(p_version text) returns jsonb language sql stable security definer set search_path='' as $$
 select payload from khub_bot.public_item_catalog_snapshot where singleton and version=p_version;
$$;
revoke all on function public.read_item_catalog_manifest(),public.read_item_catalog_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.read_item_catalog_manifest(),public.read_item_catalog_snapshot(text) to anon,authenticated;
notify pgrst,'reload schema';
commit;
