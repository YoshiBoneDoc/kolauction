# Wall of Shame

The website route is `/wall-of-shame`, linked from the main auction navigation.
Artwork is decorative; it does not claim to depict a particular KoL player.

## Enable the gallery

Apply `migrations/queue/202610190020_wall_of_shame.sql` after migration `019`.
Move the script out of `queue/` yourself after successful application. Deploy the
updated website. No bot restart is needed for `020` alone. Without `020`, the page
shows an unavailable message; it does not pretend the gallery is empty.

Banning an account does **not** automatically publish it. The private
`khub_bot.account_bans.reason` remains private. Only explicitly reviewed records
in `khub_bot.ban_publications` appear publicly. Review the actual KoL name and
player ID, reason and evidence before publishing. Public users cannot write entries.

## Publish a reviewed ban

In Supabase SQL Editor, first locate the ban and linked verified identity:

```sql
select b.id as ban_id, b.kol_player_id, p.kol_player_name, b.active,
       b.reason as private_reason
from khub_bot.account_bans b
left join public.profiles p on p.kol_player_id = b.kol_player_id
order by b.created_at desc;
```

Replace the example values below with the reviewed ban's ID, exact verified KoL
name and a short **public** reason. Do not copy private evidence into this field.
For a player without a profile, verify the identity from genuine KoL records.

```sql
insert into khub_bot.ban_publications
    (ban_id, kol_player_name, public_reason, banned_at)
values
    (123, 'Exact verified KoL name', 'Brief documented public reason', now());
```

A null `expires_at` displays **Permanent ban**. For a temporary ban, supply the
actual intended end timestamp in `expires_at` as well. This controls gallery
visibility only: the operator still needs to lift the underlying ban at that time.
The gallery excludes expired entries and any ban whose `active` flag is false.
Future `published_at` timestamps are not yet public. Entries are paginated.

## Correct or remove an entry

```sql
-- Correct a public explanation after review.
update khub_bot.ban_publications
set public_reason = 'Corrected public explanation'
where ban_id = 123;

-- Remove from the wall without changing the actual account restriction.
delete from khub_bot.ban_publications where ban_id = 123;
```

For an overturned ban, also follow the full ban/unban procedure in `README.md`:
deactivate matching ban records, clear the profile flag, and lift any separate
Supabase Auth ban. Removing a portrait alone does not restore account access.
Appeals are directed to teres minor (#3552305) through KoL KMail.
