# KoL Auction Hub

> **Returning to this project? The auction bot lives in `bot/` inside this project.**
> It runs separately on **Oracle Cloud**, not on Cloudflare. Start with
> [the bot README](bot/README.md) and [deployment instructions](bot/DEPLOYMENT.md).

## Where everything lives

| Part | Local files | Hosting |
|---|---|---|
| Website | `src/` | Cloudflare |
| Accounts and auction database | `supabase/` setup files | Supabase |
| Auction middleman bot: kHub (#3888760) | **`bot/`** | **Oracle Cloud**, Docker container `khub-bot` |

The bot was moved to Oracle and reported working on October 19, 2026.
Its server folder is `~/khub-bot`. Confirm the current server/IP in the Oracle
console when returning; these details can change.

## Important: the bot is excluded from this Git repository

**`/bot/` is deliberately gitignored. A fresh clone of this website repository
will not contain the bot, its credentials, or its SSH keys.**

Keep a separate private backup or private repository for the bot code. Its own
ignore rules exclude `.env` and `keys/`; back up those credentials separately and
privately. The local SSH keys currently live in `bot/keys/`.

Editing the local bot does not update Oracle automatically. From `bot/`, run
`npm run bundle` to create `exports/khub-bot.tar.gz`, then follow the deployment
guide to upload it and rebuild the hosted container. The archive excludes secrets.

**Stop the Oracle bot before starting a Mac copy, even in read-only mode.** Both
modes log into the same KoL account and can repeatedly replace each other's sessions.

## Useful starting points

- [Outstanding work](ROADMAP.md)
- [Database setup](supabase/README.md)
- [Bot operation and troubleshooting](bot/README.md)
- [Bot packaging and deployment](bot/DEPLOYMENT.md)

Bot links work when the local `bot/` folder is present; it is intentionally absent
from the website's GitHub repository.
