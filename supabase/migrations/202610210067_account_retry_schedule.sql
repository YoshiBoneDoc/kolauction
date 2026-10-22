-- Apply after 066, then deploy the matching bot. No requests or secrets are discarded.
begin;
alter table khub_bot.account_jobs
    add column attempt_count bigint not null default 0 check (attempt_count>=0),
    add column next_attempt_at timestamptz not null default clock_timestamp();
create index account_jobs_retry_due on khub_bot.account_jobs(next_attempt_at,created_at,mail_id) where state='pending';

-- Reserve the attempt BEFORE contacting Auth, so a lost response or restart
-- cannot bypass the cooldown. The first attempt plus two retries are immediate;
-- from the third attempt onward, the next attempt must wait five minutes.
create function public.bot_begin_account_attempt(p_mail_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare claimed text;
begin
    update khub_bot.account_jobs
        set attempt_count=attempt_count+1,
            next_attempt_at=clock_timestamp()+case when attempt_count>=2 then interval '5 minutes' else interval '0 seconds' end
        where mail_id=p_mail_id and state='pending' and next_attempt_at<=clock_timestamp()
        returning mail_id into claimed;
    return claimed is not null;
end; $$;
revoke all on function public.bot_begin_account_attempt(text) from public,anon,authenticated;
grant execute on function public.bot_begin_account_attempt(text) to service_role;

create or replace function public.bot_pending_account_requests() returns jsonb
language sql stable security definer set search_path='' as $$
    select coalesce(jsonb_agg(due.payload order by due.next_attempt_at,due.created_at,due.mail_id),'[]'::jsonb)
    from (
        select r.payload,j.next_attempt_at,j.created_at,j.mail_id
        from khub_bot.account_jobs j join khub_bot.receipts r on r.mail_id=j.mail_id
        where j.state='pending' and j.next_attempt_at<=now()
        order by j.next_attempt_at,j.created_at,j.mail_id limit 2
    ) due;
$$;
notify pgrst,'reload schema';
commit;
