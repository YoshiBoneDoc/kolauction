-- Run once after the profiles migration. Existing accounts are unchanged.
begin;

-- Return only availability flags, never profile records or email addresses.
-- Includes unconfirmed Auth accounts, so submitting the form cannot silently
-- resend signup or change pending signup details for an existing address.
create function public.registration_conflicts(p_username text, p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_username text := btrim(p_username);
    v_email text := lower(btrim(p_email));
begin
    if v_username is null or char_length(v_username) not between 1 and 16
       or v_email is null or char_length(v_email) not between 3 and 254 then
        raise exception 'Enter a valid username and email address.';
    end if;

    return pg_catalog.jsonb_build_object(
        'username_taken', exists (
            select 1 from public.profiles
            where lower(khub_username) = lower(v_username)
        ),
        'email_taken', exists (
            select 1 from auth.users where lower(email) = v_email
        )
    );
end;
$$;

revoke all on function public.registration_conflicts(text, text) from public, anon, authenticated;
grant execute on function public.registration_conflicts(text, text) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
