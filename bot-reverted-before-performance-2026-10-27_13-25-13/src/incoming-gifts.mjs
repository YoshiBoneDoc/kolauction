import { logMailFailure } from './operator-logs.mjs';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';
import { normalizeMail, parseCommand, whole, BOT_ID } from './protocol.mjs';
import { readCompleteInbox } from './inbox.mjs';

export const GIFT_WRAPPERS = new Set([1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1460,1534,2683,3430]);
const auctionCommands = new Set(['list','bid','bid_help','buy','fund','fill']);
const marker = '<p>Inside Note:<p>';

export function giftEnvelope(raw) {
    if (raw.type !== 'giftshop' || Number(raw.fromid) === BOT_ID || Number(raw.fromid) === 0) return null;
    whole(raw.id, 'gift mail ID'); whole(raw.fromid, 'gift sender'); whole(raw.azunixtime, 'gift time');
    const parsed = KmailMailbox.parse(raw.message, 'giftshop');
    const outer = KmailMailbox.parse(raw.message.split(marker)[0], 'normal');
    if (parsed.insideNote !== null && outer.items.length === 0 && outer.meat === 0) return { id: String(raw.id), wrapper_id: null, opened: true, raw };
    if (outer.items.length !== 1 || !GIFT_WRAPPERS.has(outer.items[0].id) || outer.items[0].quantity !== 1 || outer.meat !== 0) {
        throw new Error('Unrecognized gift wrapper; inspect the original KMail.');
    }
    return { id: String(raw.id), wrapper_id: outer.items[0].id, opened: parsed.insideNote !== null, raw };
}

export function openedGiftPayload(envelope, raw, legacyDonation = false) {
    const current = giftEnvelope(raw);
    if (!current?.opened || (current.wrapper_id !== null && current.wrapper_id !== envelope.wrapper_id)
        || ['id','fromid','fromname','azunixtime'].some(key => String(raw[key]) !== String(envelope.raw[key]))
        || KmailMailbox.parse(raw.message, 'giftshop').msg !== KmailMailbox.parse(envelope.raw.message, 'giftshop').msg) {
        throw new Error('Opened package does not match its original KMail.');
    }
    const outside = KmailMailbox.parse(raw.message, 'giftshop').msg;
    const command = parseCommand(outside);
    const donation = legacyDonation || !auctionCommands.has(command.type);
    // The outside wrapper is NOT an acquired item. Parse only the attachments
    // following the inside note; never spend or refund the wrapper itself.
    const inside = raw.message.slice(raw.message.indexOf(marker) + marker.length);
    // Use the gift parser's inside-attachment path. Ordinary KMail parsing
    // mistakes a Meat-only <center><table> attachment for a Valentine header
    // when the sender leaves the inside note empty, discarding the funds.
    // A synthetic empty gift outside excludes the consumed wrapper entirely.
    const attachments = KmailMailbox.parse(marker + inside, 'giftshop');
    const body = donation ? 'DONATE' : outside;
    const normalized = normalizeMail({ ...raw, type: 'normal', message: body }, () => ({
        ...attachments, msg: body, insideNote: null,
    }));
    if (!normalized) throw new Error('Opened gift contents cannot be normalized.');
    normalized.raw.gift_original = raw;
    return normalized;
}

export function verifyGiftBalances(before, after, wrapper, mail) {
    if (BigInt(after.meat) < BigInt(before.meat) + BigInt(mail.meat)) throw new Error('Gift Meat acquisition could not be verified.');
    const expected = new Map(Object.entries(before.items).map(([id, qty]) => [String(id), BigInt(qty)]));
    expected.set(String(wrapper), (expected.get(String(wrapper)) || 0n) - 1n);
    for (const item of mail.items) expected.set(String(item.id), (expected.get(String(item.id)) || 0n) + BigInt(item.quantity));
    for (const [id, qty] of expected) if (BigInt(after.items[id] || 0) < qty) throw new Error('Gift item acquisition could not be verified.');
}

// Every open is a single, non-retried write preceded by a durable claim. A
// restart may verify its updated original KMail, but may never issue it again.
export async function prepareIncomingGifts({ store, transport, shouldStop, pause, log, packageBudget }) {
    let raw = await readCompleteInbox(transport.client);
    let state;
    const register = async () => {
        const envelopes = raw.filter(mail => mail.type === 'giftshop').map(giftEnvelope).filter(Boolean);
        state = await store.rpc('bot_register_gift_mail', { p_envelopes: envelopes });
    };
    await register();
    let opened = 0;
    for (let n = 0; n < 100; n++) {
        if (shouldStop()) return false;
        let attempt = state.attempt;
        if (!attempt) {
            const pending = state.mails.filter(mail => !mail.payload);
            if (!pending.length) break;
            if (!await transport.prepareTransfers()) return false;
            attempt = await store.rpc('bot_claim_gift_open', { p_snapshot: await transport.snapshot() });
            if (!attempt) break;
            try { await transport.openGiftPackage(attempt.wrapper_id); }
            catch { /* Read-only verification below is safe even after timeout. */ }
            await pause();
            raw = await readCompleteInbox(transport.client);
        }
        const changed = state.mails.filter(mail => !mail.payload).map(envelope => {
            const current = raw.find(mail => String(mail.id) === envelope.id);
            if (!current && envelope.legacy_donation) return null;
            if (!current) throw new Error('An unopened gift KMail is missing; intake is held for review.');
            return { envelope, current, parsed: giftEnvelope(current) };
        }).filter(row => row?.parsed.opened);
        if (changed.length !== 1 || changed[0].envelope.wrapper_id !== attempt.wrapper_id) {
            throw new Error('Gift opening is unconfirmed or ambiguous. No further package will be opened; inspect the durable gift intake record.');
        }
        const { envelope, current } = changed[0];
        const payload = openedGiftPayload(envelope, current, envelope.legacy_donation);
        const after = await transport.snapshot();
        verifyGiftBalances(attempt.before_state, after, attempt.wrapper_id, payload);
        await store.rpc('bot_finish_gift_open', { p_attempt: attempt.id, p_mail: payload, p_snapshot: after });
        if (packageBudget) packageBudget[attempt.wrapper_id] = String(BigInt(packageBudget[attempt.wrapper_id] || 0) > 0n ? BigInt(packageBudget[attempt.wrapper_id]) - 1n : 0n);
        opened++;
        // Record arrivals between opens. All contents are correlated by the
        // changed ORIGINAL message, never by assumed stack order or sender.
        await register();
    }
    transport.pendingGiftMails = state.mails.filter(mail => mail.payload && !mail.legacy_donation && !mail.posted).map(mail => mail.payload);
    transport.bankedGiftIds = new Set([...(state.legacy_ids || []), ...state.mails.filter(mail => mail.legacy_donation).map(mail => mail.id)]);
    transport.openedGifts = new Map(state.mails.filter(mail => mail.payload && !mail.legacy_donation).map(mail => [mail.id, mail.payload]));
    if (state.mails.some(mail => !mail.payload && !mail.legacy_donation)) throw new Error('Gift intake has unopened packages; finish this batch before declaring the inbox complete.');
    if (opened) log(`Verified ${opened} opened gift package(s) against their original KMail. Auction deposits and donations remain separate.`);
    return true;
}

// Isolation mode (098): a failed open never blocks other packages. Unknown
// surplus is reserved separately from the ordinary, fully funded ledger.
export async function prepareIsolatedGifts({ store, transport, shouldStop, pause, log, reserve = 0 }) {
    transport.giftProtectionActive = false;
    transport.isolateIncomingGifts = true;
    transport.giftOperatingReserve = reserve;
    let raw = await readCompleteInbox(transport.client);
    let state = await store.rpc('bot_gift_intake_state');
    const review = async (mail, reason) => {
        await store.rpc('bot_review_gift_mail', { p_raw: mail, p_evidence: reason });
        log(`KMail ${mail.id}: gift set aside for review; other packages continue. Its unidentified assets remain protected.`);
        logMailFailure(log, mail, 'Gift envelope requires review');
    };
    const register = async () => {
        for (const mail of raw.filter(mail => mail.type === 'giftshop')) {
            if (state.reviews.includes(String(mail.id))) continue;
            try {
                const envelope = giftEnvelope(mail);
                if (envelope) state = await store.rpc('bot_register_gift_mail', { p_envelopes: [envelope] });
            } catch {
                await review(mail, 'Gift envelope cannot be safely registered; retain original mail and protect unidentified contents.');
            }
        }
        state = await store.rpc('bot_gift_intake_state');
    };
    const snapshot = async () => ({ ...await transport.snapshot(), reserve,
        observed_normal: raw.filter(mail => mail.type === 'normal').map(mail => {
            try { const parsed = KmailMailbox.parse(mail.message, 'normal');return { id: String(mail.id), meat: whole(parsed.meat, 'pending Meat'), items: parsed.items }; }
            catch { return { id: String(mail.id), meat: 0 }; }
        }),
    });
    const isolate = async (attempt, ids, reason) => {
        await store.rpc('bot_isolate_gift_open', { p_attempt: attempt.id, p_mail_ids: ids, p_evidence: reason });
        log(`Gift opening ${attempt.id} set aside for review; other requests continue. Unidentified assets stay reserved.`);
        for (const id of ids) {
            const original = raw.find(mail => String(mail.id) === String(id));
            if (original) logMailFailure(log, original, 'Gift opening could not be verified');
        }
    };
    await register();
    let verified = 0;
    for (let n = 0; n < 100; n++) {
        if (shouldStop()) return false;
        let attempt = state.attempt;
        const rawBeforeOpen = raw;
        const changed = () => state.mails.filter(mail => !mail.payload).flatMap(envelope => {
            const current = raw.find(mail => String(mail.id) === envelope.id);
            if (!current) return [];
            const priorReview = state.review_mail.find(row => row.mail_id === envelope.id);
            if (priorReview && priorReview.raw.message === current.message) return [];
            try { return giftEnvelope(current)?.opened ? [{ envelope, current }] : []; }
            catch { return []; }
        });
        let opened = changed();
        if (!attempt && !opened.length) {
            if (!await transport.prepareTransfers()) return false;
            attempt = await store.rpc('bot_claim_gift_open', { p_snapshot: await snapshot() });
            if (!attempt) break;
            try { await transport.openGiftPackage(attempt.wrapper_id); }
            catch { /* Verification is read-only. Never resend a payment or assume a sender. */ }
            await pause();
            try { raw = await readCompleteInbox(transport.client); }
            catch {
                await isolate(attempt, [attempt.before_state.requested_mail_id].filter(Boolean), 'Inbox verification unavailable after opening; quarantine this attempt, no assumed assets or sender.');
                break;
            }
            opened = changed();
        }
        if (!opened.length) {
            if (attempt) {
                const after = await transport.snapshot();
                const consumed = BigInt(after.items[attempt.wrapper_id] || 0) < BigInt(attempt.before_state.items[attempt.wrapper_id] || 0)
                    || raw.some(mail => mail.type === 'giftshop' && rawBeforeOpen.some(prior => String(prior.id) === String(mail.id) && prior.message !== mail.message));
                // A stack entry may have belonged to an unparseable, unregistered
                // message. Never blame the requested sender for that other entry.
                await isolate(attempt, consumed ? [] : [attempt.before_state.requested_mail_id].filter(Boolean), 'No verifiable original KMail change after opening; retain for review, skip to other requests.');
            }
            state = await store.rpc('bot_gift_intake_state');
            continue;
        }
        for (const { envelope, current } of opened) {
            const source = attempt?.wrapper_id === envelope.wrapper_id ? attempt : state.isolated.find(row => row.wrapper_id === envelope.wrapper_id);
            if (!source) { await review(current, 'Opened gift has no durable opening record; preserve its contents for manual reconciliation.');continue; }
            let payload;
            try { payload = openedGiftPayload(envelope, current, envelope.legacy_donation); }
            catch {
                if (attempt) await isolate(attempt, [envelope.id], 'Opened gift contents cannot be parsed or matched; protect assets and continue other packages.');
                await review(current, 'Opened gift contents cannot be parsed; protect assets and continue other packages.');
                continue;
            }
            try {
                await store.rpc('bot_finish_gift_open', { p_attempt: source.id, p_mail: payload, p_snapshot: await snapshot() });
                verified++;
            } catch {
                // A lost acknowledgment may follow a successful database commit.
                state = await store.rpc('bot_gift_intake_state');
                if (state.mails.find(mail => mail.id === envelope.id)?.payload) { verified++;continue; }
                if (attempt) await isolate(attempt, [envelope.id], 'Gift contents were not committed as secured; protect assets and continue other packages.');
                await review(current, 'Gift contents could not be confirmed as secured; retain for review without allocating its assets.');
            }
        }
        await register();
        // Reviewed, unparseable opened mail is intentionally skipped next time.
        const unresolved = changed().filter(row => !state.reviews.includes(row.envelope.id));
        if (!attempt && !unresolved.length && !state.mails.some(mail => !mail.payload && !state.reviews.includes(mail.id))) break;
    }
    state = await store.rpc('bot_gift_intake_state');
    transport.pendingGiftMails = state.mails.filter(mail => mail.payload && !mail.legacy_donation && !mail.posted).map(mail => mail.payload);
    transport.bankedGiftIds = new Set([...(state.legacy_ids || []), ...state.reviews,
        ...state.mails.filter(mail => mail.legacy_donation || !mail.payload).map(mail => mail.id)]);
    transport.openedGifts = new Map(state.mails.filter(mail => mail.payload && !mail.legacy_donation).map(mail => [mail.id, mail.payload]));
    transport.giftProtectionStore = store;
    if (verified) log(`Verified ${verified} gift package(s); packages needing review were skipped and their assets remain protected.`);
    return true;
}
