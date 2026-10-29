-- Keep unchanged, manually resolved gift mail resolved across worker scans/restarts.
-- Depends on 098. No sends, package opening, or ledger changes.
begin;

create or replace function public.bot_review_gift_mail(p_raw jsonb,p_evidence text)
returns void language plpgsql security definer set search_path='' as $$
begin
    perform pg_advisory_xact_lock(3888760);
    if coalesce(p_raw->>'id','') !~ '^[1-9][0-9]*$'
        or coalesce(p_raw->>'type','')<>'giftshop'
        or length(btrim(coalesce(p_evidence,'')))<12 then
        raise exception 'Invalid review mail.';
    end if;
    -- Retaining the same original mail must not erase the operator's resolution
    -- or reset verified operating funds. A changed message needs a new review.
    if exists(select 1 from khub_bot.gift_mail_reviews r
        where r.mail_id=p_raw->>'id' and r.resolved_at is not null and r.raw=p_raw) then
        return;
    end if;
    if not khub_bot.gift_review_active() then
        update khub_bot.gift_asset_protection set safe_operating_meat=0 where id;
    end if;
    insert into khub_bot.gift_mail_reviews(mail_id,raw,evidence)
        values(p_raw->>'id',p_raw,p_evidence)
        on conflict(mail_id) do update set raw=excluded.raw,evidence=excluded.evidence,
            resolved_at=null,resolution=null;
end;$$;

alter function public.bot_gift_intake_state() rename to gift_state_before_resolved_reviews;
alter function public.gift_state_before_resolved_reviews() set schema khub_bot;
revoke all on function khub_bot.gift_state_before_resolved_reviews() from public,anon,authenticated,service_role;

create function public.bot_gift_intake_state() returns jsonb
language sql security definer set search_path='' as $$
select khub_bot.gift_state_before_resolved_reviews() || jsonb_build_object(
    'resolved_review_mail',coalesce((select jsonb_agg(jsonb_build_object('mail_id',r.mail_id,'raw',r.raw))
        from khub_bot.gift_mail_reviews r where r.resolved_at is not null),'[]'::jsonb));
$$;
revoke all on function public.bot_gift_intake_state() from public,anon,authenticated;
grant execute on function public.bot_gift_intake_state() to service_role;

commit;
