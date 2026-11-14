-- After 268. Additive engine only; financial integration/activation is separate.
-- Stop the sole worker when installing the full 269-271 chain. Apply once.
begin;
set local lock_timeout='2s';
set local statement_timeout='60s';
select pg_advisory_xact_lock(3888760);
create table khub_bot.fee_engine_state(singleton boolean primary key default true check(singleton), enabled boolean not null default false);
insert into khub_bot.fee_engine_state values(true,false);
create table khub_bot.loyalty_rates(tier integer primary key check(tier between 0 and 4),name text unique not null,minimum numeric not null,bps integer[] not null);
insert into khub_bot.loyalty_rates values
 (0,'Base',0,array[500,400,300,200]),(1,'Silver',50000000,array[400,300,250,150]),
 (2,'Gold',200000000,array[300,250,200,125]),(3,'Platinum',1000000000,array[250,200,150,100]),(4,'Diamond',3000000000,array[200,150,100,50]);
create table khub_bot.loyalty_sales(auction_id uuid primary key references public.auctions(id),user_id uuid not null references public.profiles(id),volume numeric not null check(volume>0));
create table khub_bot.loyalty_accounts(user_id uuid primary key references public.profiles(id),volume numeric not null default 0,tier integer not null default 0 references khub_bot.loyalty_rates(tier));
insert into khub_bot.loyalty_sales select id,seller_id,final_price from public.auctions where auction_kind='sell' and escrow_mode and status='completed' and winner_id is not null and final_price>0;
insert into khub_bot.loyalty_accounts select user_id,sum(volume),(select max(tier) from khub_bot.loyalty_rates where minimum<=sum(s.volume)) from khub_bot.loyalty_sales s group by user_id;
create function khub_bot.record_loyalty_sale() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.auction_kind='sell' and new.escrow_mode and new.status='completed' and new.winner_id is not null and new.final_price>0 then
  insert into khub_bot.loyalty_sales values(new.id,new.seller_id,new.final_price) on conflict do nothing;
  if found then
   insert into khub_bot.loyalty_accounts(user_id,volume) values(new.seller_id,new.final_price)
   on conflict(user_id) do update set volume=khub_bot.loyalty_accounts.volume+excluded.volume;
   update khub_bot.loyalty_accounts a set tier=greatest(a.tier,(select max(r.tier) from khub_bot.loyalty_rates r where r.minimum<=a.volume)) where user_id=new.seller_id;
  end if;
 end if;
 return new;
end;$$;
create trigger record_loyalty_sale after insert or update of status on public.auctions for each row execute function khub_bot.record_loyalty_sale();

create table khub_bot.escrow_promotions(
 id uuid primary key default gen_random_uuid(),revision integer not null default 1,
 config jsonb not null, state text not null default 'draft' check(state in ('draft','published','ended','cancelled')),
 starts_at timestamptz,ends_at timestamptz,ended_at timestamptz,
 legacy boolean not null default false,created_at timestamptz not null default clock_timestamp(),
 check(ends_at is null or ends_at>starts_at)
);
create index escrow_promotions_schedule on khub_bot.escrow_promotions(starts_at,ends_at) where state='published';
-- Preserve existing November ledger, enabled flag and grandfathered cohort verbatim.
-- Stable identity identifies the existing promotion, not a fresh allowance period.
insert into khub_bot.escrow_promotions(id,config,state,starts_at,legacy)
select '00000000-0000-0000-0000-000000000011',jsonb_build_object(
 'name','Giving Thanks: November Promotion','description','Shared introductory allowance across Buy and Sell.',
 'mode','lower','tiers','[0,1,2,3,4]'::jsonb,'allowance','20000000','donor_waiver',true,
 'sell','[{"from":0,"bps":200},{"from":1000000000,"bps":100}]'::jsonb,
 'buy','[{"from":0,"bps":200},{"from":1000000000,"bps":100}]'::jsonb,
 'info_message',E'Your first 20M Meat in escrow sales is commission-free.\nIf you''re below 20M, your entire next trade is entirely free, regardless of value.\nAfter that, commission is 2% on the first 1B Meat and 1% above 1B.',
 'form_message','For November: Your next trade is commission-free while your completed escrow volume is under 20m Meat, regardless of the trade''s value. Afterward, commission is 2% on the first 1b Meat and 1% above.'),
 case when enabled then 'published' else 'ended' end,
 coalesce((select min(created_at) from khub_bot.promotional_escrow_volume),'2026-11-03'::timestamptz),true
from khub_bot.escrow_promotion_config where id;
do $$begin if not exists(select 1 from khub_bot.escrow_promotions where legacy) then raise exception 'Existing November config is missing';end if;end;$$;
create table khub_bot.promotion_volume(transaction_key text primary key,promotion_id uuid not null references khub_bot.escrow_promotions(id),user_id uuid not null references public.profiles(id),volume numeric not null check(volume>0));
create index promotion_volume_user on khub_bot.promotion_volume(promotion_id,user_id);
create table khub_bot.promotion_balances(promotion_id uuid not null references khub_bot.escrow_promotions(id),user_id uuid not null references public.profiles(id),volume numeric not null default 0,primary key(promotion_id,user_id));
create table khub_bot.promotion_audit(id bigint generated always as identity primary key,promotion_id uuid references khub_bot.escrow_promotions(id),actor uuid,action text not null,details jsonb not null,created_at timestamptz not null default clock_timestamp());
create table khub_bot.auction_fee_terms(auction_id uuid primary key references public.auctions(id),user_id uuid not null references public.profiles(id),normal_bps integer[] not null,tier integer not null,promotion_id uuid references khub_bot.escrow_promotions(id),legacy boolean not null default false,eligibility jsonb not null,created_at timestamptz not null default clock_timestamp());
create table khub_bot.escrow_fee_decisions(transaction_key text primary key,auction_id uuid not null references public.auctions(id),user_id uuid not null references public.profiles(id),price bigint not null,fee bigint not null,promotion_id uuid references khub_bot.escrow_promotions(id),normal_fee bigint not null,created_at timestamptz not null default clock_timestamp());

create function khub_bot.fee_bands(p_bps integer[]) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_agg(jsonb_build_object('from',v,'bps',p_bps[i]) order by i) from unnest(array[0::bigint,10000000,100000000,1000000000]) with ordinality t(v,i);
$$;
create function khub_bot.flat_band_fee(p_price bigint,p_bands jsonb) returns bigint language sql immutable set search_path='' as $$
 select floor(p_price::numeric*(select (b->>'bps')::integer from jsonb_array_elements(p_bands)b where (b->>'from')::bigint<=p_price order by (b->>'from')::bigint desc limit 1)/10000)::bigint;
$$;
-- Financial ranks are global. Private ignore lists must never improve eligibility.
-- Totals reuse the existing maintenance snapshot, indexed by each category.
create function khub_bot.fee_eligibility(p_user uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare t integer:=0; rates integer[]; leaders uuid[]; top3 uuid[]; donors uuid[]; snapshot timestamptz;
begin
 select coalesce(a.tier,0) into t from khub_bot.loyalty_accounts a where user_id=p_user;t:=coalesce(t,0);
 select bps into rates from khub_bot.loyalty_rates where tier=t;
 select refreshed_at into snapshot from khub_bot.leaderboard_state where singleton;
 if snapshot is null then raise exception 'Fee eligibility snapshot unavailable';end if;
 with ranked as (
  select id,row_number() over(order by score desc,id) r from (select p.id,t.volume score from khub_bot.leaderboard_totals t join public.profiles p on p.id=t.profile_id where t.volume>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id) and not exists(select 1 from khub_bot.leaderboard_exclusions e where e.kol_player_id=p.kol_player_id) order by t.volume desc,t.profile_id limit 3) candidates
 ), counted as (
  select id,row_number() over(order by score desc,id) r from (select p.id,t.trades score from khub_bot.leaderboard_totals t join public.profiles p on p.id=t.profile_id where t.trades>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id) and not exists(select 1 from khub_bot.leaderboard_exclusions e where e.kol_player_id=p.kol_player_id) order by t.trades desc,t.profile_id limit 3) candidates
 ), donated as (
  select p.id from khub_bot.leaderboard_totals t join public.profiles p on p.id=t.profile_id where t.donated>0 and p.kol_verified_at is not null and not khub_bot.profile_is_restricted(p.id) and not exists(select 1 from khub_bot.leaderboard_exclusions e where e.kol_player_id=p.kol_player_id) order by t.donated desc,t.profile_id limit 1
 ), all_traders as(select * from ranked union all select * from counted)
 select (select array_agg(id) from all_traders where r=1),(select array_agg(id) from all_traders),(select array_agg(id) from donated) into leaders,top3,donors;
 if p_user=any(donors) then rates:=array[0,0,0,0];
 elsif p_user=any(leaders) then select array_agg(least(v,w) order by n) into rates from unnest(rates,array[100,100,50,50]) with ordinality x(v,w,n);
 elsif p_user=any(top3) then select array_agg(least(v,w) order by n) into rates from unnest(rates,array[150,125,75,50]) with ordinality x(v,w,n);end if;
 return jsonb_build_object('tier',t,'bps',to_jsonb(rates),'donor',coalesce(p_user=any(donors),false),'leader',coalesce(p_user=any(leaders),false),'top3',coalesce(p_user=any(top3),false),'snapshot_at',snapshot);
end;$$;
create function khub_bot.live_escrow_promotion(p_now timestamptz default statement_timestamp()) returns uuid language sql stable set search_path='' as $$
 select id from khub_bot.escrow_promotions where state='published' and starts_at<=p_now and (ends_at is null or p_now<ends_at) and (not legacy or (select enabled from khub_bot.escrow_promotion_config where id)) order by starts_at limit 1;
$$;
create function khub_bot.promotion_fee(p_price bigint,p_kind text,p_config jsonb,p_normal bigint,p_tier integer,p_donor boolean,p_volume numeric,p_legacy boolean default false,p_free boolean default false) returns bigint language plpgsql immutable set search_path='' as $$
declare f bigint;
begin
 if not (p_config->'tiers' @> to_jsonb(array[p_tier])) then return p_normal;end if;
 if p_free or p_volume<(p_config->>'allowance')::numeric then f:=0;
 elsif p_legacy then f:=khub_bot.promotional_fee(p_price);
 else f:=khub_bot.flat_band_fee(p_price,p_config->p_kind);end if;
 if p_donor and (p_config->>'donor_waiver')::boolean then return 0;end if;
 return case when p_config->>'mode'='lower' then least(p_normal,f) else f end;
end;$$;
create function khub_bot.promotion_messages(p_config jsonb,p_legacy boolean default false) returns jsonb language plpgsql stable set search_path='' as $$
declare explanation text; kind text; rates text;
begin
 if p_legacy then return jsonb_build_object('info',p_config->>'info_message','form',p_config->>'form_message');end if;
 explanation:=p_config->>'name'||': ';
 foreach kind in array array['sell','buy'] loop
  select string_agg((b->>'from')||'+ Meat: '||trim(to_char((b->>'bps')::numeric/100,'FM990.99'))||'%', '; ' order by (b->>'from')::bigint) into rates from jsonb_array_elements(p_config->kind)b;
  explanation:=explanation||initcap(kind)||' '||rates||'. ';
 end loop;
 explanation:=explanation||'Eligible tiers: '||(select string_agg(name,', ' order by tier) from khub_bot.loyalty_rates where p_config->'tiers' @> to_jsonb(array[tier]))||'. ';
 if (p_config->>'allowance')::numeric>0 then explanation:=explanation||'A whole completed transaction is free while prior shared Buy/Sell promotional volume is below '||(p_config->>'allowance')||' Meat. ';end if;
 explanation:=explanation||case when p_config->>'mode'='lower' then 'The lower of promotional and locked normal fees applies. ' else 'Promotional fees replace normal fees. ' end||case when (p_config->>'donor_waiver')::boolean then 'The locked top-donor waiver is preserved. ' else 'Replacement may override the top-donor waiver. ' end||'Promotion terms are retained for trades created during the promotion.';
 return jsonb_build_object('info',coalesce(nullif(btrim(p_config->>'info_message'),''),explanation),'form',coalesce(nullif(btrim(p_config->>'form_message'),''),explanation));
end;$$;
-- Lock every new private object down. Only security-definer public RPCs expose it.
do $$declare obj record;begin
 for obj in select tablename from pg_tables where schemaname='khub_bot' and tablename in ('fee_engine_state','loyalty_rates','loyalty_sales','loyalty_accounts','escrow_promotions','promotion_volume','promotion_balances','promotion_audit','auction_fee_terms','escrow_fee_decisions') loop
 execute format('alter table khub_bot.%I enable row level security',obj.tablename);
 execute format('revoke all on khub_bot.%I from public,anon,authenticated,service_role',obj.tablename);end loop;
 for obj in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='khub_bot' and p.proname in ('record_loyalty_sale','fee_bands','flat_band_fee','fee_eligibility','live_escrow_promotion','promotion_fee','promotion_messages') loop execute format('revoke all on function %s from public,anon,authenticated,service_role',obj.signature);end loop;
end;$$;
commit;
