-- Apply after 057. Read-only, administrator-only ban history for an appeal.
-- Preserve exact timestamps and full reasons; never manufacture support messages
-- or KMail deliveries. Existing ban records and audit history stay unchanged.
begin;
create index account_ban_activity_ban_id_idx on khub_bot.account_ban_activity(ban_id);
create function public.read_appeal_ban_history(p_report_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    with matching_bans as materialized (
        select b.* from khub_bot.bug_reports r join public.profiles p on p.id=r.reporter_id
        join khub_bot.account_bans b on b.kol_player_id=p.kol_player_id
            or lower(btrim(b.username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name)))
        where r.id=p_report_id and r.category='appeal'
    ), events as (
        select 'ban-event-'||v.id as id,v.created_at,
            case when not (v.new_state->>'active')::boolean then 'removed'
                when v.previous_state is null then 'issued' else 'updated' end as action,
            coalesce(v.new_state->>'reason','') as reason,
            (v.new_state->>'expires_at')::timestamptz as expires_at,
            coalesce(p.khub_username,'Operator') as administrator_username
        from khub_bot.account_ban_activity v join matching_bans b on b.id=v.ban_id
        left join public.profiles p on p.id=v.administrator_id
        where v.previous_state is null
            or v.previous_state->'active' is distinct from v.new_state->'active'
            or v.previous_state->'reason' is distinct from v.new_state->'reason'
            or v.previous_state->'expires_at' is distinct from v.new_state->'expires_at'
        union all
        -- Bans predating the audit trigger retain their original creation time.
        -- If an old ban was edited, the first audit's previous state preserves
        -- its original reason/expiry instead of attributing a later edit to it.
        select 'ban-start-'||b.id,b.created_at,'issued',
            coalesce(initial.state->>'reason',''),
            (initial.state->>'expires_at')::timestamptz,'Operator'
        from matching_bans b
        cross join lateral (select coalesce((select v.previous_state from khub_bot.account_ban_activity v
            where v.ban_id=b.id order by v.id limit 1),to_jsonb(b)) as state) initial
        where not exists(select 1 from khub_bot.account_ban_activity v where v.ban_id=b.id and v.previous_state is null)
    )
    select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc),'[]'::jsonb) into result from events e;
    return result;
end; $$;
revoke all on function public.read_appeal_ban_history(uuid) from public,anon,authenticated;
grant execute on function public.read_appeal_ban_history(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
