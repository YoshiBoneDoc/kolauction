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
