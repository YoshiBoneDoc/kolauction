-- Apply after 208, then rebuild the standalone bot. No live transfers here.
begin;
select pg_advisory_xact_lock(3888760);
create table khub_bot.raffle_intake_holds (
 mail_id text primary key, payload jsonb not null, verified_gift boolean not null,
 created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.raffle_intake_holds enable row level security;
revoke all on khub_bot.raffle_intake_holds from public,anon,authenticated,service_role;
-- Gifts already reserve their verified payload in shared liabilities. Ordinary
-- KMail uses the same receipt-to-obligation handoff: never count both.
alter function public.bot_liabilities() rename to liabilities_before_raffle_intake_isolation;
alter function public.liabilities_before_raffle_intake_isolation() set schema khub_bot;
revoke all on function khub_bot.liabilities_before_raffle_intake_isolation() from public,anon,authenticated,service_role;
create function khub_bot.add_raffle_intake_holds(p_base jsonb) returns jsonb language sql security definer set search_path='' as $$
 with base as(select p_base b), held as(
 select payload p from khub_bot.raffle_intake_holds h where not verified_gift
 and not exists(select 1 from khub_bot.receipts r where r.mail_id=h.mail_id)),
 assets as(select key,value::numeric n from base,jsonb_each_text(b->'items') union all
 select x->>'id',(x->>'quantity')::numeric from held,jsonb_array_elements(p->'items') x),
 totals as(select key,sum(n) n from assets group by key)
 select jsonb_build_object('meat',((b->>'meat')::numeric+coalesce((select sum((p->>'meat')::numeric) from held),0))::text,
 'items',coalesce((select jsonb_object_agg(key,n::text) from totals),'{}')) from base;
$$;
revoke all on function khub_bot.add_raffle_intake_holds(jsonb) from public,anon,authenticated,service_role;
create function public.bot_liabilities() returns jsonb language sql security definer set search_path='' as $$
 select khub_bot.add_raffle_intake_holds(khub_bot.liabilities_before_raffle_intake_isolation());
$$;
revoke all on function public.bot_liabilities() from public,anon,authenticated;
grant execute on function public.bot_liabilities() to service_role;
create function public.bot_isolate_raffle_intake(p_mail jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare mid text:=p_mail->>'id'; old khub_bot.receipts; held khub_bot.raffle_intake_holds; gift boolean:=coalesce(p_mail->'raw' ? 'gift_original',false); x jsonb;
begin
 perform pg_advisory_xact_lock(3888760);
 if mid is null or mid!~'^[1-9][0-9]{0,15}$' or p_mail#>>'{raw,type}' is distinct from 'normal'
 or not (coalesce(p_mail#>>'{command,type}','') in ('raffle','raffle_supply','raffle_advance')
 or (p_mail#>>'{command,type}'='gift_command_inside' and p_mail#>>'{command,intended}' in ('raffle','raffle_supply','supply')))
 or coalesce(p_mail->>'meat','')!~'^[0-9]{1,16}$' or (p_mail->>'meat')::numeric>9007199254740991
 or coalesce(p_mail->>'sender_id','')!~'^[1-9][0-9]{0,15}$'
 or jsonb_typeof(p_mail->'items') is distinct from 'array' then raise exception 'Invalid raffle isolation payload'; end if;
 for x in select value from jsonb_array_elements(p_mail->'items') loop
  if coalesce(x->>'id','')!~'^[1-9][0-9]{0,9}$' or (x->>'id')::numeric>2147483647
  or coalesce(x->>'quantity','')!~'^[1-9][0-9]{0,15}$' then raise exception 'Invalid isolated item'; end if;
 end loop;
 select * into old from khub_bot.receipts where mail_id=mid;
 if found then
  if old.payload is distinct from p_mail and not khub_bot.rejected_raffle_replay(p_mail) then raise exception 'Receipt payload conflict'; end if;
  if old.result in ('processing','account_pending') or old.result is null then raise exception 'Intake state unresolved'; end if;
  return jsonb_build_object('state','committed','result','duplicate');
 end if;
 select * into held from khub_bot.raffle_intake_holds where mail_id=mid;
 if found and held.payload is distinct from p_mail then raise exception 'Isolated payload conflict'; end if;
 if gift and not exists(select 1 from khub_bot.incoming_gifts g where g.mail_id=mid and g.payload=p_mail and not g.legacy_donation) then raise exception 'Gift contents have not been verified'; end if;
 insert into khub_bot.raffle_intake_holds(mail_id,payload,verified_gift) values(mid,p_mail,gift) on conflict(mail_id) do nothing;
 return jsonb_build_object('state','isolated');
end $$;
create function public.bot_pending_raffle_intake() returns jsonb language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(payload),'[]') from (
 select h.payload from khub_bot.raffle_intake_holds h where not exists(select 1 from khub_bot.receipts r where r.mail_id=h.mail_id)
 order by h.created_at,h.mail_id limit 100) h;
$$;
revoke all on function public.bot_isolate_raffle_intake(jsonb),public.bot_pending_raffle_intake() from public,anon,authenticated,service_role;
grant execute on function public.bot_isolate_raffle_intake(jsonb),public.bot_pending_raffle_intake() to service_role;
-- Draw and settlement generation wait for unresolved raffle intake, including
-- after a restart or if the original KMail disappears. Existing deliveries run.
create function khub_bot.raffle_intake_pending() returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from khub_bot.raffle_intake_holds h where not exists(select 1 from khub_bot.receipts r where r.mail_id=h.mail_id));
$$;
revoke all on function khub_bot.raffle_intake_pending() from public,anon,authenticated,service_role;
do $$ declare sig text; source text; begin
 -- Surplus quarantine must not reserve ordinary held attachments a second time.
 foreach sig in array array['public.bot_refresh_gift_protection(jsonb)','public.bot_claim_gift_open(jsonb)'] loop
  source:=pg_get_functiondef(sig::regprocedure);
  if strpos(source,'b:=khub_bot.liabilities_before_gift_isolation();')=0 then raise exception 'Unexpected gift liability base'; end if;
  execute replace(source,'b:=khub_bot.liabilities_before_gift_isolation();','b:=khub_bot.add_raffle_intake_holds(khub_bot.liabilities_before_gift_isolation());');
 end loop;
 foreach sig in array array['public.bot_raffle_draw_work()','public.bot_raffle_tick()'] loop
  source:=pg_get_functiondef(sig::regprocedure);
  if strpos(source,E'begin\n')=0 then raise exception 'Unexpected raffle work definition'; end if;
  execute replace(source,E'begin\n',E'begin\n if khub_bot.raffle_intake_pending() then return'||case when sig like '%draw_work%' then ' ''[]''::jsonb' else '' end||E'; end if;\n');
 end loop;
 source:=pg_get_functiondef('public.bot_ingest_mail(jsonb)'::regprocedure);
 if strpos(source,'perform pg_advisory_xact_lock(3888760);')=0 then raise exception 'Unexpected intake lock'; end if;
 execute replace(source,'perform pg_advisory_xact_lock(3888760);',$patch$
 perform pg_advisory_xact_lock(3888760);
 if exists(select 1 from khub_bot.raffle_intake_holds h where h.mail_id=p_mail->>'id' and h.payload is distinct from p_mail) then raise exception 'Isolated payload conflict'; end if;
$patch$);
 source:=pg_get_functiondef('public.bot_worker_status()'::regprocedure);
 if strpos(source,'''raffleBackendVersion'',2')=0 then raise exception 'Unexpected worker capability definition'; end if;
 execute replace(source,'''raffleBackendVersion'',2','''raffleBackendVersion'',2,''raffleIntakeIsolationVersion'',1');
end $$;
notify pgrst,'reload schema';
commit;
