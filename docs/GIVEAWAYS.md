# Giveaway auctions

Apply `supabase/migrations/queue/202610290153_giveaway_auctions.sql` in Supabase SQL Editor before deploying the website and bot. The matching standalone bot copy is in `bot/supabase/migrations/`. Deploy the new `giveaway-image` Cloudflare Pages function with the website so the card can remove only the white background connected to the image edges, preserving white details inside the item outline.

Administrators get a Giveaway preset above Preview Auction. It selects Meat Stack Mania, 1,000 dense meat stacks and a 1 Meat minimum. The title, item, quantity, minimum, duration and settlement method remain editable. Switching to Buy or Bundle turns off the single-item giveaway preset.

The live giveaway appears above High Rollers and as the first card in the All Auctions grid, independently of filters and pagination. Featured data refreshes every 30 seconds. Giveaways use the ordinary next minimum bid, but bidders must submit exactly that amount. Ordinary bid increments and ordinary auctions retain their existing behavior. Giveaway deadlines do not extend after late bids.

Giveaway chat announcements are enabled by default. Set `BOT_GIVEAWAY_CHAT_ANNOUNCEMENTS=false` and restart the bot to disable them temporarily. Regular six-hour announcements retain their existing setting. While disabled, giveaways are not claimed for chat.

When enabled, the live bot checks for giveaway announcements after a healthy auction cycle. A database claim is saved before chat is sent, independently of the six-hour announcement schedule. A crash or ambiguous response after claiming can omit the announcement; it cannot automatically post a duplicate. Inspect bot logs for unconfirmed sends. No announcement is claimed while the bot is blocked, stopping or in maintenance.

Checks:

- `python3 tests/giveaway_database_test.py` — isolated PostgreSQL; no live credentials.
- `node --experimental-sqlite --test bot/tests/chat-announcements.test.mjs bot/tests/giveaway-announcements.test.mjs`
- `npm run build`
