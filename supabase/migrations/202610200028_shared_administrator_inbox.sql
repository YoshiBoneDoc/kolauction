-- Apply after 027. Existing reports become bug messages; queued KMail stays unchanged.
begin;
alter table khub_bot.bug_reports add column category text not null default 'bug'
    check (category in ('bug','trade','appeal','other'));
create index support_inbox_category_idx on khub_bot.bug_reports(category,status,created_at desc,report_number desc);
create table khub_bot.support_category_activity (
    id bigint generated always as identity primary key,
    report_id uuid not null references khub_bot.bug_reports(id),
    administrator_id uuid not null references public.profiles(id),
    previous_category text not null,
    category text not null,
    created_at timestamptz not null default clock_timestamp()
);
alter table khub_bot.support_category_activity enable row level security;
revoke all on khub_bot.support_category_activity from public,anon,authenticated;
grant all on khub_bot.support_category_activity to service_role;
grant usage on sequence khub_bot.support_category_activity_id_seq to service_role;

create function public.read_support_inbox(p_category text default 'all',p_status text default 'open',p_page integer default 1)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('all','bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    if p_status is null or p_status not in ('open','resolved','all') or p_page is null or p_page not between 1 and 1000000 then
        raise exception 'Choose a valid inbox page and status.';
    end if;
    with matching as materialized (
        select * from khub_bot.bug_reports where (p_status='all' or status=p_status) and (p_category='all' or category=p_category)
    ), page as (
        select * from matching order by created_at desc,report_number desc limit 20 offset (p_page-1)*20
    )
    select jsonb_build_object('total',(select count(*) from matching),'reports',
        coalesce((select jsonb_agg(jsonb_build_object(
            'category',r.category,'id',r.id,'reference','B-'||r.report_number,'body',r.body,'status',r.status,'created_at',r.created_at,
            'reporter_username',r.reporter_username,'reporter_kol_id',r.reporter_kol_id,
            'resolved_at',r.resolved_at,
            'notification',case
                when not exists(select 1 from khub_bot.bug_report_deliveries l where l.report_id=r.id) then 'not_queued'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='unknown') then 'needs_review'
                when exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state='sending') then 'sending'
                when not exists(select 1 from khub_bot.bug_report_deliveries l join khub_bot.deliveries d on d.id=l.delivery_id
                    where l.report_id=r.id and d.state<>'sent') then 'sent'
                else 'queued' end
        ) order by r.created_at desc,r.report_number desc) from page r),'[]'::jsonb)) into result;
    return result;
end; $$;

create function public.set_support_category(p_report_id uuid,p_category text) returns void
language plpgsql security definer set search_path='' as $$
declare r khub_bot.bug_reports%rowtype;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_category is null or p_category not in ('bug','trade','appeal','other') then
        raise exception 'Choose a valid inbox category.';
    end if;
    select * into r from khub_bot.bug_reports where id=p_report_id for update;
    if not found then raise exception 'Message not found.'; end if;
    if r.category=p_category then return; end if;
    update khub_bot.bug_reports set category=p_category where id=p_report_id;
    insert into khub_bot.support_category_activity(report_id,administrator_id,previous_category,category)
        values(r.id,auth.uid(),r.category,p_category);
end; $$;
revoke all on function public.read_support_inbox(text,text,integer),public.set_support_category(uuid,text)
    from public,anon,authenticated;
grant execute on function public.read_support_inbox(text,text,integer),public.set_support_category(uuid,text) to authenticated;
notify pgrst,'reload schema';
commit;
