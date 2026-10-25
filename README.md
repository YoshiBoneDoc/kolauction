# KoL Auction Hub

> **Returning to this project? The auction bot lives in `bot/` inside this project.**
> It runs separately on **Oracle Cloud**, not on Cloudflare. Start with
> [the bot README](bot/README.md) and [deployment instructions](bot/DEPLOYMENT.md).

Starting a new chat? Read [the project handoff](HANDOFF.md) first.

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

### Preventing credential leaks

Website builds reject private-key material, privileged Supabase keys, secret
`VITE_` variables, and private files/backups in public assets or generated output.
The browser's Supabase **publishable** key is public by design; the bot's secret
key and KoL password belong only in its private server environment.

The bot packager also scans its allowlisted files before creating an upload
archive. Keep credentials and SSH keys out of source, `public/`, build output,
and deployment archives. `.gitignore` does not protect files already tracked by
Git, and removing a tracked file does not remove its earlier history.

`npm run security:check` scans nonignored website source without displaying
credentials. `npm run security:install` installs the local pre-commit check
(preserving an existing custom hook). It checks staged file contents and rejects
forced additions of private files. Install it again on a fresh clone; Git hooks
are local and can be bypassed. Guard tests: `node --test tests/asset-security.test.mjs`.

New registration uses KMail to **kHub (#3888760)**: `REGISTER`. The bot creates and links the account, then sends a generated
password. `CREDENTIALS` from the linked KoL player issues a new password. This needs
the matching bot/website update and queued migration `019`; see the database setup.
Existing email accounts retain their login/history and can use KMail recovery once linked.
New accounts do not require SMTP.

- [Outstanding work](ROADMAP.md)
- [Database setup](supabase/README.md)
- [Item catalog and automatic weekly updates](supabase/ITEM_CATALOG.md)
- [Bot operation and troubleshooting](bot/README.md)
- [Bot packaging and deployment](bot/DEPLOYMENT.md)

Bot links work when the local `bot/` folder is present; it is intentionally absent
from the website's GitHub repository.

## For pushing changes to git from kolauction folder:

From your project's terminal, run these one at a time:

```bash
git status
git add .
git commit -m "Brief description of your changes"
git push origin main
```
