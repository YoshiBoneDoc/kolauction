begin;
create or replace function public.set_account_restriction(p_user_id uuid,p_reason text,p_expires_at timestamptz default null) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; v_reason text:=btrim(p_reason);
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if p_user_id=auth.uid() then raise exception 'You cannot ban your own administrator account.'; end if;
    if v_reason is null or char_length(v_reason) not between 3 and 1000 or (p_expires_at is not null and p_expires_at<=now()) then
        raise exception 'Add a reason and a future expiry, or leave expiry empty for a permanent ban.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into p from public.profiles where id=p_user_id;
    if not found then raise exception 'Account not found.'; end if;
    update khub_bot.account_bans set active=false where active and (kol_player_id=p.kol_player_id or lower(btrim(username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))));
    insert into khub_bot.account_bans(kol_player_id,username,reason,expires_at) values(p.kol_player_id,p.khub_username,v_reason,p_expires_at);
end; $$;
create or replace function public.lift_account_restriction(p_user_id uuid,p_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; v_reason text:=btrim(p_reason);
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if v_reason is null or char_length(v_reason) not between 3 and 1000 then raise exception 'Add a reason in 3 to 1,000 characters.'; end if;
    perform pg_advisory_xact_lock(3888760);
    select * into p from public.profiles where id=p_user_id;
    if not found then raise exception 'Account not found.'; end if;
    update khub_bot.account_bans set active=false,reason=v_reason where active and
        (kol_player_id=p.kol_player_id or lower(btrim(username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))));
end; $$;

create function public.read_admin_accounts(p_search text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; term text:=lower(btrim(p_search)); lookup text;
begin
    if not khub_bot.is_administrator(auth.uid()) then raise exception 'Administrator access required.' using errcode='42501'; end if;
    if term is null or char_length(term) not between 2 and 100 then raise exception 'Enter 2 to 100 characters of a username or player number.'; end if;
    lookup:=regexp_replace(term,'^kh_','');
    select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'username',p.khub_username,'player_id',p.kol_player_id,
        'is_banned',khub_bot.account_is_banned(p.kol_player_id,p.khub_username,p.kol_player_name),
        'expires_at',case when restrictions.permanent then null else restrictions.expires_at end,
        'reason',restrictions.reason) order by p.khub_username,p.id),'[]'::jsonb) into result
    from (select * from public.profiles where strpos(lower(khub_username),term)>0
        or (lookup<>'' and strpos(lower(khub_username),lookup)>0)
        or strpos(lower(coalesce(kol_player_name,'')),term)>0 or kol_player_id::text=ltrim(term,'#')
        order by khub_username,id limit 20) p
    left join lateral (select bool_or(b.expires_at is null) as permanent,max(b.expires_at) as expires_at,
        (array_agg(b.reason order by b.id desc))[1] as reason from khub_bot.account_bans b
        where b.active and (b.expires_at is null or b.expires_at>now()) and
        (b.kol_player_id=p.kol_player_id or lower(btrim(b.username)) in (lower(btrim(p.khub_username)),lower(btrim(p.kol_player_name))))) restrictions on true;
    return result;
end; $$;
revoke all on function public.read_admin_accounts(text) from public,anon,authenticated;
grant execute on function public.read_admin_accounts(text) to authenticated;

notify pgrst,'reload schema';
commit;
