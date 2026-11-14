-- After 270. Compact administrator controls and authoritative read-only previews.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
create table khub_bot.promotion_requests(request_id uuid primary key,actor uuid not null,action text not null,payload jsonb not null,result jsonb not null);
alter table khub_bot.promotion_requests enable row level security;
revoke all on khub_bot.promotion_requests from public,anon,authenticated,service_role;
create function khub_bot.validate_promotion(p_config jsonb) returns void language plpgsql immutable set search_path='' as $$
declare kind text;b jsonb;last_from bigint;amount numeric;begin
 if jsonb_typeof(p_config) is distinct from 'object' or coalesce(length(btrim(p_config->>'name')),0) not between 1 and 100 or coalesce(length(p_config->>'description'),0)>1000
 or p_config->>'mode' is null or p_config->>'mode' not in ('lower','replace') or jsonb_typeof(p_config->'donor_waiver') is distinct from 'boolean'
 or jsonb_typeof(p_config->'tiers') is distinct from 'array' or jsonb_array_length(p_config->'tiers') not between 1 and 5
 or coalesce(p_config->>'allowance','')!~'^[0-9]{1,16}$'
 or coalesce(length(p_config->>'info_message'),0)>2000 or coalesce(length(p_config->>'form_message'),0)>2000 then raise exception 'Invalid promotion details';end if;
 if exists(select 1 from jsonb_array_elements(p_config->'tiers') t where t::text not in ('0','1','2','3','4')) or (select count(distinct t) from jsonb_array_elements(p_config->'tiers')t)<>jsonb_array_length(p_config->'tiers') then raise exception 'Choose eligible loyalty tiers';end if;
 foreach kind in array array['sell','buy'] loop
  if jsonb_typeof(p_config->kind) is distinct from 'array' or jsonb_array_length(p_config->kind) not between 1 and 12 then raise exception 'Specify Buy and Sell rate brackets';end if;
  last_from:=-1;
  for b in select * from jsonb_array_elements(p_config->kind) loop
   if coalesce(b->>'from','')!~'^[0-9]{1,16}$' or coalesce(b->>'bps','')!~'^[0-9]{1,5}$' then raise exception 'Use whole Meat boundaries and basis-point rates';end if;
   amount:=(b->>'from')::numeric;
   if (last_from=-1 and amount<>0) or amount<=last_from or amount>9007199254740991 or (b->>'bps')::integer>10000 then raise exception 'Invalid bracket order or percentage';end if;
   last_from:=amount;
  end loop;
 end loop;
 -- Lower-only promotions always preserve the top donor's normal zero rate.
 if p_config->>'mode'='lower' and not (p_config->>'donor_waiver')::boolean then raise exception 'Lower-only promotions preserve the donor waiver';end if;
end;$$;
create function khub_bot.promotion_conflicts(p_id uuid,p_start timestamptz,p_end timestamptz) returns jsonb language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',config->>'name','starts_at',starts_at,'ends_at',ends_at)),'[]'::jsonb) from khub_bot.escrow_promotions where id<>p_id and state='published' and tstzrange(starts_at,ends_at,'[)') && tstzrange(coalesce(p_start,statement_timestamp()),p_end,'[)');
$$;
create function khub_bot.promotion_preview(p_id uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare p khub_bot.escrow_promotions%rowtype;examples jsonb;begin
 select * into strict p from khub_bot.escrow_promotions where id=p_id;
 if p.state<>'draft' then raise exception 'Preview a draft configuration';end if;
 perform khub_bot.validate_promotion(p.config);
 select jsonb_agg(jsonb_build_object('amount',amount::text,'tier',r.name,'privilege',benefit.label,'kind',kind,'prior_volume',vol::text,'normal_fee',n.fee::text,'fee',khub_bot.promotion_fee(amount,kind,p.config,n.fee,r.tier,benefit.label='Top donor',vol)::text) order by amount,r.tier,benefit.label,kind,vol) into examples
 from khub_bot.loyalty_rates r cross join (values (1000000::bigint),(10000000),(100000000),(1000000000),(2000000000)) amounts(amount)
 cross join (values ('Normal',null::integer[]),('Leader',array[100,100,50,50]),('Top 3',array[150,125,75,50]),('Top donor',array[0,0,0,0])) benefit(label,bps)
 cross join (values('sell'),('buy')) k(kind)
 cross join lateral (select distinct v vol from (values(0::numeric),((p.config->>'allowance')::numeric))v(v)) volumes
 cross join lateral (select khub_bot.flat_band_fee(amount,khub_bot.fee_bands(array(select least(a,coalesce(b,a)) from unnest(r.bps,coalesce(benefit.bps,r.bps))x(a,b)))) fee)n;
 return jsonb_build_object('id',p.id,'revision',p.revision,'config',p.config,'starts_at',p.starts_at,'ends_at',p.ends_at,'messages',khub_bot.promotion_messages(p.config),'examples',examples,'conflicts',khub_bot.promotion_conflicts(p.id,p.starts_at,p.ends_at),'confirmation',md5(p.id::text||p.revision::text||p.config::text||coalesce(extract(epoch from p.starts_at)::text,'immediate')||coalesce(extract(epoch from p.ends_at)::text,'indefinite')));
end;$$;

create function public.admin_escrow_promotions(p_action text default 'read',p_id uuid default null,p_revision integer default null,p_config jsonb default null,p_start timestamptz default null,p_end timestamptz default null,p_confirmation text default null,p_request uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare p khub_bot.escrow_promotions%rowtype;result jsonb;preview jsonb;payload jsonb;prior khub_bot.promotion_requests%rowtype;v_now timestamptz;begin
 if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required' using errcode='42501';end if;
 if p_action='read' then
  return jsonb_build_object('engine_enabled',(select enabled from khub_bot.fee_engine_state where singleton),'live_id',khub_bot.live_escrow_promotion(),'promotions',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('messages',khub_bot.promotion_messages(x.config,x.legacy)) order by created_at desc) from (select * from khub_bot.escrow_promotions order by (id=khub_bot.live_escrow_promotion()) desc,(state='published') desc,(state='draft') desc,created_at desc limit 100)x),'[]'::jsonb));
 end if;
 if p_action='preview' then return khub_bot.promotion_preview(p_id);end if;
 if p_action is null or p_action not in ('save','publish','end','cancel') or p_request is null then raise exception 'Specify action and request identity';end if;
 perform pg_advisory_xact_lock(3888760);v_now:=clock_timestamp();
 payload:=jsonb_build_object('id',p_id,'revision',p_revision,'config',p_config,'start',p_start,'end',p_end,'confirmation',p_confirmation);
 select * into prior from khub_bot.promotion_requests where request_id=p_request;
 if found then
  if prior.actor<>auth.uid() or prior.action<>p_action or prior.payload<>payload then raise exception 'Request identity changed';end if;return prior.result;
 end if;
 if p_id is not null then
  select * into strict p from khub_bot.escrow_promotions where id=p_id for update;
  if p_revision is distinct from p.revision then raise exception 'Promotion changed; refresh and preview again';end if;
 end if;
 if p_action='save' then
  if p_id is not null and p.state<>'draft' then raise exception 'Only drafts can be edited';end if;
  perform khub_bot.validate_promotion(p_config);
  if (p_start is not null and not isfinite(p_start)) or (p_end is not null and (not isfinite(p_end) or p_end<=coalesce(p_start,v_now))) then raise exception 'Choose a valid start and expiration';end if;
  if p_id is null and (select count(*) from khub_bot.escrow_promotions where state='draft')>=25 then raise exception 'Cancel an unused draft before creating more (maximum 25)';end if;
  if p_id is null then insert into khub_bot.escrow_promotions(config,starts_at,ends_at) values(p_config,p_start,p_end) returning * into p;
  else update khub_bot.escrow_promotions set config=p_config,starts_at=p_start,ends_at=p_end,revision=revision+1 where id=p_id returning * into p;end if;
 elsif p_action='publish' then
  if p.id is null or p.state<>'draft' then raise exception 'Publish a reviewed draft';end if;
  if not (select enabled from khub_bot.fee_engine_state where singleton) then raise exception 'Owner must activate the fee engine before publishing';end if;
  preview:=khub_bot.promotion_preview(p.id);
  if p_confirmation is distinct from preview->>'confirmation' then raise exception 'Preview this revision before confirming publication';end if;
  if p.starts_at is not null and p.starts_at<v_now then raise exception 'Scheduled start has passed; edit and preview again';end if;
  if p.ends_at is not null and p.ends_at<=coalesce(p.starts_at,v_now) then raise exception 'Expiration has passed';end if;
  if jsonb_array_length(khub_bot.promotion_conflicts(p.id,p.starts_at,p.ends_at))>0 then raise exception 'Conflicts with a live or scheduled promotion';end if;
  update khub_bot.escrow_promotions set state='published',starts_at=coalesce(starts_at,v_now),revision=revision+1 where id=p.id returning * into p;
 else
  if p.id is null or p.state not in ('published','draft') then raise exception 'Promotion already ended or cancelled';end if;
  if p_confirmation is distinct from 'CONFIRM' then raise exception 'Explicit confirmation required';end if;
  update khub_bot.escrow_promotions set state=case when p_action='end' then 'ended' else 'cancelled' end,ended_at=v_now,revision=revision+1 where id=p.id returning * into p;
  if p.legacy then update khub_bot.escrow_promotion_config set enabled=false where id;end if;
 end if;
 result:=to_jsonb(p);
 insert into khub_bot.promotion_audit(promotion_id,actor,action,details) values(p.id,auth.uid(),p_action,result);
 insert into khub_bot.promotion_requests values(p_request,auth.uid(),p_action,payload,result);
 return result;
end;$$;
-- Remove the old toggle as a mutation path: no silent resurrection/overlap.
create or replace function public.set_escrow_promotion(p_enabled boolean) returns void language plpgsql security definer set search_path='' as $$
begin raise exception 'Use Administration Promotion with preview and confirmation';end;$$;
create or replace function public.admin_escrow_promotion(p_enabled boolean default null) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required' using errcode='42501';end if;
 if p_enabled is not null then raise exception 'Use the updated Promotion controls';end if;
 return jsonb_build_object('enabled',khub_bot.live_escrow_promotion() is not null);
end;$$;

create function public.escrow_fee_quote(p_price bigint,p_quantity bigint default 1,p_kind text default 'sell',p_auction uuid default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t khub_bot.auction_fee_terms%rowtype;e jsonb;p khub_bot.escrow_promotions%rowtype;bands jsonb;normal bigint;fee bigint;volume numeric:=0;reserve bigint;engine boolean;amount bigint;legacy boolean:=false;a public.auctions%rowtype;actor uuid;begin
 if p_price is null or p_price<0 or p_quantity is null or p_quantity<1 or p_kind is null or p_kind not in ('sell','buy') or p_price::numeric*p_quantity>9007199254740991 then raise exception 'Invalid fee quote';end if;
 if auth.uid() is not null and khub_bot.profile_is_restricted(auth.uid()) then raise exception 'Account restricted' using errcode='42501';end if;
 engine:=(select enabled from khub_bot.fee_engine_state where singleton);amount:=p_price*p_quantity;
 if p_auction is not null then
  select * into strict a from public.auctions where id=p_auction;
  if auth.uid() is null or (auth.uid()<>a.seller_id and not khub_bot.is_administrator(auth.uid())) then raise exception 'Fee terms are private' using errcode='42501';end if;
  select * into t from khub_bot.auction_fee_terms where auction_id=p_auction;
  if not a.escrow_mode then return jsonb_build_object('fee','0','normal_fee','0','enabled',false,'engine_enabled',engine);end if;
 end if;
 if engine then
  e:=case when t.auction_id is not null then t.eligibility else khub_bot.fee_eligibility(auth.uid()) end;
  bands:=khub_bot.fee_bands(array(select jsonb_array_elements_text(e->'bps')::integer));
  normal:=khub_bot.flat_band_fee(amount,bands);
 else normal:=case when p_kind='buy' and p_price>0 then floor(khub_bot.buy_fee_numerator(p_price)*p_quantity/10000)::bigint else khub_bot.tiered_escrow_fee(amount) end;end if;
 if t.legacy then normal:=least(normal,case when p_kind='buy' and p_price>0 then floor(khub_bot.buy_fee_numerator(p_price)*p_quantity/10000)::bigint else khub_bot.tiered_escrow_fee(amount) end);end if;
 if t.promotion_id is not null then select * into strict p from khub_bot.escrow_promotions where id=t.promotion_id;
 else select * into p from khub_bot.escrow_promotions where id=khub_bot.live_escrow_promotion() and (p_auction is null or escrow_promotions.legacy);end if;
 actor:=coalesce(t.user_id,auth.uid());
 fee:=normal;
 if p.id is not null then
  if p.legacy then select coalesce(sum(v.volume),0) into volume from khub_bot.promotional_escrow_volume v where user_id=actor;
  else select coalesce((select b.volume from khub_bot.promotion_balances b where promotion_id=p.id and user_id=actor),0) into volume;end if;
  legacy:=p.legacy;
  fee:=khub_bot.promotion_fee(amount,p_kind,case when not engine and p.legacy then p.config||'{"mode":"replace"}'::jsonb else p.config end,normal,coalesce((e->>'tier')::integer,0),coalesce((e->>'donor')::boolean,false),volume,p.legacy,coalesce((select promotional_remaining_free from khub_bot.buy_orders where auction_id=p_auction),false) and p.legacy);
 end if;
 if p_kind='buy' then
  if t.auction_id is not null then reserve:=khub_bot.locked_buy_cost(p_auction,p_price,p_quantity)-amount;
  elsif engine then
   select max(value::integer) into reserve from jsonb_array_elements_text(e->'bps');
   if p.id is not null and p.config->>'mode'='replace' and p.config->'tiers' @> to_jsonb(array[(e->>'tier')::integer]) then select greatest(reserve,max((b->>'bps')::integer)) into reserve from jsonb_array_elements(p.config->'buy')b;end if;
   reserve:=ceil(p_price::numeric*reserve/10000)::bigint*p_quantity;
  elsif p_price>0 then reserve:=ceil(khub_bot.buy_fee_numerator(p_price)*p_quantity/10000)::bigint;else reserve:=0;end if;
 end if;
 return jsonb_build_object('fee',fee::text,'normal_fee',normal::text,'enabled',p.id is not null,'engine_enabled',engine,'volume',volume::text,'promotion',case when p.id is not null then jsonb_build_object('id',p.id,'name',p.config->>'name','legacy',legacy,'config',p.config,'messages',khub_bot.promotion_messages(p.config,p.legacy),'ends_at',p.ends_at) end,'eligibility',e,'reserve',reserve::text,'funding_required',case when p_kind='buy' then (amount+reserve)::text end,'valid_until',(select min(boundary) from (select starts_at boundary from khub_bot.escrow_promotions where state='published' union all select ends_at from khub_bot.escrow_promotions where state='published')s where boundary>statement_timestamp()));
end;$$;
create or replace function public.escrow_fee_preview(p_price bigint) returns jsonb language sql stable security definer set search_path='' as $$select public.escrow_fee_quote(p_price);$$;
create or replace function public.read_my_loyalty_progress() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or khub_bot.profile_is_restricted(auth.uid()) then raise exception 'Log in with an unrestricted account' using errcode='42501';end if;
 return jsonb_build_object('completed_escrow_sales_meat',coalesce((select volume from khub_bot.loyalty_accounts where user_id=auth.uid()),0)::text);
end;$$;
revoke all on function public.admin_escrow_promotions(text,uuid,integer,jsonb,timestamptz,timestamptz,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.admin_escrow_promotions(text,uuid,integer,jsonb,timestamptz,timestamptz,text,uuid) to authenticated;
revoke all on function public.escrow_fee_quote(bigint,bigint,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.escrow_fee_quote(bigint,bigint,text,uuid) to anon,authenticated;
do $$declare obj record;begin
 for obj in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='khub_bot' and p.proname in ('validate_promotion','promotion_conflicts','promotion_preview') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',obj.signature);end loop;
end;$$;
notify pgrst,'reload schema';
commit;
