# Manual test data

Run [seed_test_accounts.sql](seed_test_accounts.sql) in Supabase SQL Editor after website migrations through 050. This is optional test data, not a production migration. The script is transactional and can be rerun without resetting passwords, removing bans, changing existing fixtures or duplicating their messages.

| Website login | Password | Profile name |
| --- | --- | --- |
| KH_test1 | test1 | test1 |
| KH_test2 | test2 | test2 |
| KH_test3 | test3 | test3 |
| KH_test4 | test4 | test4 |
| KH_test5 | test5 | test5 |
| KH_banned | banned | banned |

`banned` starts unrestricted. Ban it through **Administrator inbox → Account bans**, then sign in as `KH_banned` to test the restriction screen and appeal form. Rerunning the script preserves that ban.

The accounts use separate synthetic KoL IDs (9000000001–9000000006). Your real ID cannot be reused across profiles, and reusing teres Minor's identity would give the test accounts administrator privileges. These accounts are ordinary participants. A private delivery trigger redirects their zero-asset notification KMail to **teres Minor (#3552305)**. It rejects financial/item deliveries to the synthetic identities; it never creates inventory or escrow funds.

The script creates eleven mock auctions:

- Three open direct listings without bids, including the account intended for ban testing.
- One direct listing with two bids.
- One direct sale awaiting both responses.
- One direct sale with the buyer confirmed.
- One direct sale confirmed by both parties, with separate positive feedback.
- One direct sale with a seller incomplete report and buyer confirmation.
- One canceled direct listing.
- Two escrow listings awaiting deposits, including a minimum bid of exactly 1M.

The final SQL results show the actual auction numbers, states and page paths. Direct listings are visible on the website. Only these test accounts and teres Minor can bid on the registered mock auctions; other users receive an explicit test-auction error. Do not treat the listings as real sales. Test funded escrow with a genuinely linked account and real deposits; the pending fixture listings do not simulate inventory or payouts.

The registration reservation and normal auction RPCs remain in use; the script does not disable security triggers or replace production registration logic. Reserved IDs or names already used by unrelated records cause the transaction to fail rather than overwrite those accounts.


## Remove pre-launch test data

Use [prelaunch_cleanup.sql](prelaunch_cleanup.sql) in Supabase SQL Editor. This is a
manual maintenance script, not a migration, and has not been run against your live
project by Codex. It is intended for the pre-launch database only.

1. Stop every Oracle/local bot worker and take a database backup.
2. Run the entire file unchanged. `apply_changes=false` means **preview only**.
   Review preserved accounts, account/auction deletion lists, inbox counts and blockers.
3. Choose `scope` in the options row:
   - `all_prelaunch` (default): every current auction and every Auth account except verified teres Minor (#3552305),
     including manually created test accounts and auctions under your admin account.
   - `seeded_only`: the registered test accounts/fixtures and auctions involving those
     accounts. It leaves other accounts and their unrelated auctions in place.
   **Both modes clear the entire administrator inbox**, including incomplete reports,
   queries, appeals/evidence and review history. Removing those reports also clears
   their derived incomplete marks on any retained auction.
4. After reviewing the preview, change only `apply_changes` to `true` and rerun the
   entire file. An outstanding escrow deposit, asset delivery, closet move or uncertain
   transfer aborts the transaction. Resolve/return those assets through the normal bot
   workflow; never mark an uncertain transfer sent merely to bypass cleanup.
5. Refresh the website. Before restarting the bot, remove any unwanted **zero-asset**
   test REGISTER/CREDENTIALS requests still in its KoL inbox, especially ones it has
   never processed. SQL cannot see unprocessed game mail; the bot would treat those as
   new requests. Already-recorded requests remain deduplicated by their saved receipts.

Only your verified teres Minor account (#3552305) is protected. All other accounts
are removed in the default full reset, including any other administrator or bot
accounts. Your password and sessions stay unchanged. The script aborts unless it
finds exactly one verified account linked to your player number. Deleted Auth accounts lose their native Auth identities and
sessions through existing foreign keys; unexpected external references abort the
whole cleanup instead of cascading through unknown application data.

The catalog, settings, migration history, auction/D-/C-reference sequences, incoming
receipts and financial/reconciliation evidence are **not reset**. Only selected
pending zero-asset notices are canceled, so old inbox/test notices will not be mailed
after launch. Removed-account jobs are stopped and their pending secrets cleared.
Sent financial message bodies, attachments and delivery states remain unchanged.

Public test auctions are removed, while their snapshots are retained in the private,
RLS-protected `khub_bot.prelaunch_auction_archive` for historical delivery context.
Delivery/closet rows keep their IDs and evidence but release the deleted auction's
foreign key. For an old auction number, an operator can inspect its private snapshot:

```sql
select auction_data
from khub_bot.prelaunch_auction_archive
where auction_data->>'auction_number'='1013';
```

The script is transactional and repeatable, creates no new transfers and deliberately
does not reuse auction or delivery numbers. It leaves the empty fixture registry and
its harmless guards in place; rerunning the seed script would create test data again.

Local verification: `python3 tests/prelaunch_cleanup_test.py` uses an isolated temporary
PostgreSQL database with mocked Auth tables, all current migrations and no network.
