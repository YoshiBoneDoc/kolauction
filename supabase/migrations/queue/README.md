# Pending SQL migrations

New website migration scripts go here until you apply them manually.

1. Read the script's prerequisites and run it in Supabase SQL Editor.
2. After it succeeds, move the `.sql` file up one folder into
   `supabase/migrations/`, keeping its filename.
3. If it fails, leave it here while the error is investigated.

Run dependent scripts in migration-number order. Moving a file does not execute SQL;
local database tests use an isolated database and do not apply scripts to Supabase.

This convention starts with future scripts; existing files have not been moved.
The separate bot keeps its copies directly in `bot/supabase/migrations/`.
