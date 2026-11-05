# Raffle public-beacon fairness protocol v1

Migrations: `202611050221_raffle_fairness.sql` (after 220), then
`202611050222_raffle_fairness_input_guards.sql` for immutable input guards and
fair rotation of the five-slot pending draw queue. Requires the matching
Oracle bot bundle/rebuild and website deployment. No production actions are part of
local implementation/testing. Leave the owner's personal command guide unchanged.

## Scope and upgrade

New activations use `khub-drand-quicknet-sha256-v1`. Already-active raffles retain
the earlier draw protocol; their results are not retrospectively labelled proven.
The database reports raffle backend version 3. Older workers skip drawing while
ordinary processing continues; the matching worker accepts versions 2 and 3.
Legacy draw/settlement behavior remains available for existing obligations.

## Commitment and draw

Existing intake isolation, full inbox scan, closing grace, deduplication, receipt
ordering and financial advisory locks freeze the accepted inputs. In that same
transaction, the database records an immutable commitment and chooses the first
quicknet round scheduled at least 120 seconds later. This round cannot be replaced
if late or unavailable. No local random draw is substituted.

The exact UTF-8 manifest contains newline-separated values, with no final newline:

1. Method string `khub-drand-quicknet-sha256-v1`.
2. Raffle UUID.
3. Decimal quicknet round.
4. Decimal total ticket count.
5. Decimal ticket display-label offset.
6. SHA-256 of the frozen private input's PostgreSQL `jsonb::text` representation.
7. One line per prize, in committed outcome order:
   `outcome,itemId,quantity,probabilityBps` (decimal integers).

The commitment hash is SHA-256 of that exact manifest. The private input digest
commits to receipts and ownership without exposing their contents. It is opaque to
players: it does not independently prove the ledger's completeness or ownership.

The pinned quicknet chain is
`52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971`,
with genesis Unix time `1692803367`, period `3` seconds and the
`bls-unchained-g1-rfc9380` scheme. The full pinned public key is in the verifier.
The worker verifies the beacon's BLS signature using `drand-client@1.4.2` and checks
the requested round and randomness hash. Three redundant gateways race signature-verified responses under one four-second
deadline. Distinct ready rounds are fetched concurrently, with one request group
per round in each worker cycle. Failed rounds retry automatically on later cycles. An unavailable/invalid beacon defers only its draw; other financial
processing continues. The seed is SHA-256 of the UTF-8 string:

```
method + "\n" + commitmentHash + "\n" + beacon.randomness
```

Two distinct hash-counter streams select the ticket and prize. Each sample is
SHA-256 of UTF-8 `method + "\n" + seed + "\n" + domain + "\n" + counter`,
where domain is `ticket` or `prize`, and counter starts at decimal `0`.
Interpret the digest as an unsigned big-endian 256-bit integer. For bound B,
reject values >= `2^256 - (2^256 mod B)`, otherwise use `value mod B`.
Retry the same domain with incremented counter (maximum 128 attempts).

Ticket B is the committed total. Add 1 for its private ordinal and add the label
offset for the displayed ticket number. Prize B is 10000; choose the first ordered
prize whose cumulative basis-point weight is strictly greater than its index.
Quantity does not change a prize's weight. The streams use distinct domain labels;
the ticket result never seeds the prize result.

The database recomputes both selections, validates the frozen ranges and winner,
and preserves the existing first-commit-wins rule. BLS verification is performed by
the worker and independent verifier, not by PostgreSQL. The service-role worker is
a privileged trusted runtime; a compromised database/service role can bypass normal
application controls. The proof permits independent detection of invalid signatures
and incorrect calculations; it is not a guarantee against arbitrary operator control.

## Player verification and privacy

The small box below Ticket History fetches only a count-free summary. The full
manifest, ticket total, signature, seed, pool and outputs are fetched only after
explicitly opening Verification details. No participant list, holdings, receipt IDs,
Meat amounts or private input is in this projection. Access is restricted by the
existing administrator/accepted-club-member server permission. Since ticket price is visible, the total also makes gross ticket sales calculable.
These proof values
can be copied and shared, including the total; hiding them in the UI is discoverability
control, not a cryptographic confidentiality boundary.

The browser verifier is loaded on demand. Its standalone downloadable equivalent
can verify copied proof JSON locally with the pinned drand client, without calling
kHub or any beacon relay. Save the download and `proof.json` together in a new folder:

```
npm install --save-exact drand-client@1.4.2
node raffle-fairness-verifier.mjs proof.json [previously-saved-commitment-hash]
```

Migration 224 adds an anonymous, UUID-addressed commitment metadata read and a
permanent `/raffle/:id/commitment` page. Its record includes only the raffle UUID,
method, commitment hash, database timestamp, chain hash, round and scheduled beacon
time. It contains no manifest, ticket total, player data or result. It reads the
same immutable stored record before and after settlement; it does not reconstruct
or independently timestamp a record after the fact.

The raffle details page automatically refreshes its count-free summary while the
draw is pending (five seconds after closing; up to one minute before closing).
Hidden pages pause and completed draws stop refreshing. The commitment hash and
recorded timestamp remain visible after the draw, with copy and public-record links.
The round remains the originally scheduled round at least two minutes after the
recorded commitment. No new infrastructure or replacement rounds are introduced.

The summary offers a copyable commitment before drawing. Observing/saving it before
the specified beacon is released is important: an after-the-fact proof alone cannot
prove the operator published that commitment beforehand. The database timestamp
is not an independently witnessed external timestamp. Players may compare the
computed label with their own confirmed ticket ranges; verifying the complete
private ownership ledger requires separate private auditing. The protocol does not
force completion or payout by a malicious operator, or prove unsubmitted purchases.

Canceled/zero-ticket raffles have no selection to verify. Proofs for completed draws
survive settlement and membership changes; existing liabilities and uncertain-send
holds are never released by proof generation or verification.

## Validation

`tests/raffle-proof.test.mjs` checks cross-implementation outputs and rejects tampered
commitments, schedules, signatures, odds and results. `tests/raffle-fairness-ui.test.mjs`
checks that the normal view never fetches/renders the ticket total. Bot tests cover
signature verification, deterministic selection and outage isolation. The full
isolated PostgreSQL lifecycle suite includes commitment immutability, future round
scheduling, restart consistency, authorization, SQL/Node/browser equivalence and
settlement preservation. Historical round 42 and simulated transfer acknowledgments
are offline fixtures, not live asset-transfer evidence.
