import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('raffle SQL prerequisites and fixes match standalone bot deployment copies', () => {
 for(const name of ['202611040197_mystery_raffle_preparation.sql','202611040198_raffle_prize_probabilities.sql','202611040199_raffle_backend.sql','202611040200_raffle_manual_fulfillment.sql','202611040201_raffle_fulfillment_messages.sql','202611040202_raffle_kmail_wording.sql']) {
  const queued=`supabase/migrations/queue/${name}`;
  const path=existsSync(new URL(`../${queued}`,import.meta.url))?queued:`supabase/migrations/${name}`;
  assert.equal(read(path),read(`bot/supabase/migrations/${name}`),name);
 }
 const bundle=read('bot/tools/bundle.mjs');
 for(const entry of ["'src'","'supabase'","'tests/raffles.test.mjs'","'tests/raffle-draw.test.mjs'"])assert.ok(bundle.includes(entry));
});
