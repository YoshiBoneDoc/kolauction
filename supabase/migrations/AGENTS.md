# Migration workflow

- Put every newly created website SQL migration in `supabase/migrations/queue/`.
- The user runs queued scripts manually in Supabase SQL Editor and moves them into
  `supabase/migrations/` after successful application. Do not move them on the user's behalf.
- This convention applies to future scripts; leave existing migrations in place.
- Keep the same filename when a queued script is moved, and keep migration numbers
  unique across the parent directory and `queue/`.
- The standalone bot is exempt: put its matching copies directly in
  `bot/supabase/migrations/`, without a queue subfolder.
- Database checks must resolve website scripts from either location so the user
  does not need to move an unapplied script merely to run local tests.
