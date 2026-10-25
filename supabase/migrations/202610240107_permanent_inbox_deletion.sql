-- Apply after 106, then deploy the website. No bot rebuild is required.
-- Permanently erase message content/evidence, retaining only the reference rows
-- required by trade ratings, delivery deduplication, and financial audit links.
-- Deleting an inbox entry must NEVER settle a trade, change a rating, or retry funds.
begin;
select pg_advisory_xact_lock(3888760);
select pg_advisory_xact_lock(3888775);

alter table khub_bot.bug_reports add column deleted_at timestamptz,
    add column deleted_by uuid references public.profiles(id),
    add constraint bug_reports_deletion_actor check ((deleted_at is null)=(deleted_by is null));

-- No existing status/reopen path can restore erased content or resurrect a thread.
create function khub_bot.keep_deleted_inbox_content_erased() returns trigger
language plpgsql set search_path='' as $$
begin
    if old.deleted_at is not null then
        new.deleted_at:=old.deleted_at;
        new.deleted_by:=old.deleted_by;
    end if;
    if new.deleted_at is not null then new.body:='[Permanently deleted]';end if;
    return new;
end;$$;
create trigger keep_deleted_inbox_content_erased before update on khub_bot.bug_reports
    for each row execute function khub_bot.keep_deleted_inbox_content_erased();

create function khub_bot.purge_inbox_messages(p_report_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
begin
    -- Keep vote participation so erasing a response cannot make a one-response
    -- poll reappear or let the same account vote again. Erase its duplicate text.
    update khub_bot.site_poll_votes set response_text='[Permanently deleted]'
        where response_report_id=any(p_report_ids);
    delete from khub_bot.appeal_evidence where report_id=any(p_report_ids);
    update khub_bot.bug_reports set body='[Permanently deleted]',deleted_at=clock_timestamp(),deleted_by=auth.uid()
        where id=any(p_report_ids) and deleted_at is null;
    update khub_bot.site_polls p set final_results=jsonb_build_object('total',(
        select count(*) from khub_bot.bug_reports r where r.poll_id=p.id and r.deleted_at is null))
        where p.poll_type='free_text' and p.final_results is not null
        and p.id in(select poll_id from khub_bot.bug_reports where id=any(p_report_ids));
end;$$;

create function public.delete_support_message(p_report_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    if p_report_id is null then raise exception 'Choose a message to delete.';end if;
    perform pg_advisory_xact_lock(3888760);
    if not exists(select 1 from khub_bot.bug_reports where id=p_report_id) then raise exception 'Message not found.';end if;
    perform khub_bot.purge_inbox_messages(array[p_report_id]);
end;$$;

create function public.delete_support_thread(p_thread_id uuid,p_is_trade boolean,p_report_ids uuid[]) returns void
language plpgsql security definer set search_path='' as $$
declare actual_ids uuid[]; expected_ids uuid[];
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    if p_thread_id is null or p_is_trade is null or coalesce(cardinality(p_report_ids),0)=0
        or array_position(p_report_ids,null) is not null then raise exception 'Choose a conversation to delete.';end if;
    perform pg_advisory_xact_lock(3888760);
    if p_is_trade then perform 1 from public.auctions where id=p_thread_id for update;end if;
    select array_agg(r.id order by r.id) into actual_ids from khub_bot.bug_reports r
        left join khub_bot.trade_reports t on t.report_id=r.id
        left join khub_bot.trade_queries q on q.report_id=r.id
        where r.deleted_at is null and coalesce(t.auction_id,q.auction_id,r.poll_id,r.id)=p_thread_id
        and (t.auction_id is not null or q.auction_id is not null)=p_is_trade;
    if actual_ids is null then return;end if;
    select array_agg(distinct id order by id) into expected_ids from unnest(p_report_ids) id;
    -- Never erase a message that arrived while the administrator's confirmation
    -- was open, or messages from a different conversation supplied by a client.
    if actual_ids is distinct from expected_ids then
        raise exception 'This conversation changed. Refresh the inbox and review it before deleting.';
    end if;
    perform khub_bot.purge_inbox_messages(actual_ids);
end;$$;

create function public.delete_home_poll(p_poll_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare reports uuid[];
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501';end if;
    if p_poll_id is null then raise exception 'Choose a poll to delete.';end if;
    perform pg_advisory_xact_lock(3888760);
    perform pg_advisory_xact_lock(3888775);
    -- Voters hold a shared poll lock until their write commits. Wait before
    -- removing votes/responses so concurrent answers cannot be orphaned.
    perform 1 from khub_bot.site_polls where id=p_poll_id for update;
    if not found then return;end if;
    select array_agg(id) into reports from khub_bot.bug_reports where poll_id=p_poll_id;
    perform khub_bot.purge_inbox_messages(coalesce(reports,'{}'::uuid[]));
    delete from khub_bot.site_poll_votes where poll_id=p_poll_id;
    delete from khub_bot.site_poll_skips where poll_id=p_poll_id;
    update khub_bot.bug_reports set poll_id=null where poll_id=p_poll_id;
    delete from khub_bot.site_polls where id=p_poll_id;
end;$$;

-- Filter before grouping, status/category selection, totals and pagination. Apply
-- to legacy inbox RPCs too, so old clients cannot redisplay deleted messages.
do $$declare identity text; d text; target text;
begin
    foreach identity in array array['public.read_support_threads(text,text,integer)',
        'public.read_support_inbox(text,text,integer)','public.read_bug_report_inbox(text,integer)'] loop
        d:=pg_get_functiondef(identity::regprocedure);
        target:='from khub_bot.bug_reports r';
        if strpos(d,target)>0 then
            execute replace(d,target,'from (select * from khub_bot.bug_reports where deleted_at is null) r');
        elsif strpos(d,'from khub_bot.bug_reports where')>0 then
            execute replace(d,'from khub_bot.bug_reports where','from khub_bot.bug_reports where deleted_at is null and');
        elsif strpos(d,'public.read_support_inbox(')=0 then
            raise exception 'Unexpected inbox reader: %',identity;
        end if;
    end loop;
    d:=pg_get_functiondef('khub_bot.poll_results(uuid)'::regprocedure);
    target:='from khub_bot.bug_reports where poll_id=p_poll_id';
    if strpos(d,target)=0 then raise exception 'Unexpected text response counter.';end if;
    execute replace(d,target,target||' and deleted_at is null');
end;$$;

revoke all on function khub_bot.keep_deleted_inbox_content_erased(),khub_bot.purge_inbox_messages(uuid[])
    from public,anon,authenticated,service_role;
revoke all on function public.delete_support_message(uuid),public.delete_support_thread(uuid,boolean,uuid[]),public.delete_home_poll(uuid)
    from public,anon,authenticated;
grant execute on function public.delete_support_message(uuid),public.delete_support_thread(uuid,boolean,uuid[]),public.delete_home_poll(uuid)
    to authenticated;
notify pgrst,'reload schema';
commit;
