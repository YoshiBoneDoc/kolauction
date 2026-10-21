-- Apply after 056. Resolve an appeal's exact account using its stored reporter ID,
-- never a fuzzy username search or a client-supplied account ID. Admin-only.
begin;
create function public.read_appeal_account(p_report_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
    if not khub_bot.is_administrator(auth.uid()) then
        raise exception 'Administrator access required.' using errcode='42501';
    end if;
    select jsonb_build_object('id',p.id,'username',p.khub_username,'player_id',p.kol_player_id,
        'is_banned',khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name),
        'expires_at',case when restrictions.permanent then null else restrictions.expires_at end,
        'reason',restrictions.reason) into result
    from khub_bot.bug_reports r join public.profiles p on p.id=r.reporter_id
    left join lateral (
        select bool_or(b.expires_at is null) as permanent,max(b.expires_at) as expires_at,
            (array_agg(b.reason order by b.id desc))[1] as reason
        from khub_bot.account_bans b
        where b.active and (b.expires_at is null or b.expires_at>now()) and
            (b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in
                (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))))
    ) restrictions on true
    where r.id=p_report_id and r.category='appeal';
    return result;
end; $$;
revoke all on function public.read_appeal_account(uuid) from public,anon,authenticated;
grant execute on function public.read_appeal_account(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
