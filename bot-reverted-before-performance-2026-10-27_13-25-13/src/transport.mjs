import { Client } from 'kol.js';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';
import { createHash } from 'node:crypto';
import { ClosetTransferError } from './closet.mjs';
import { logMailFailure } from './operator-logs.mjs';
import { mailResponseDiagnostic, confirmedMailRejection } from './mail-diagnostics.mjs';
import { BOT_ID, BOT_NAME, GiftDeliveryError, GiftBudgetDeferredError, MailDeliveryError, normalizeMail, whole } from './protocol.mjs';
import { parseSentPage, matchSentDelivery } from './sent-mail.mjs';
import { readCompleteInbox, compareMail } from './inbox.mjs';
import { parseDocument, DomUtils } from 'htmlparser2';
import { selectAll } from 'css-select';

// Keep only a conventional page name, never query strings, hosts or arbitrary
// path segments that could contain a session secret.
function safePage(location) {
    try {
        const pathname = new URL(location, 'https://www.kingdomofloathing.com').pathname;
        return /^\/[a-z][a-z0-9_-]{0,39}\.php$/i.test(pathname) ? pathname : 'other';
    } catch { return 'other'; }
}

// Match the recipient's real profile header, not arbitrary quoted profile text.
// KoL.js uses these same explicit (Hardcore)/(In Ronin) status labels.
export function recipientGiftStatus(html, recipientId) {
    const doc = parseDocument(String(html));
    const identity = selectAll('b', doc).find(node => {
        let sibling = node.next;
        while (sibling?.type === 'text' && !sibling.data.trim()) sibling = sibling.next;
        return sibling?.type === 'text' && sibling.data.trim().startsWith(`(#${recipientId})`);
    });
    if (!identity) return null;
    for (let parent = identity.parent; parent; parent = parent.parent) {
        if (['blockquote', 'form', 'textarea', 'pre'].includes(parent.name)) return null;
    }
    let header = identity.parent;
    while (header && header.name !== 'center') header = header.parent;
    if (!header) return null;
    return selectAll('b', header).some(node => {
        for (let parent = node.parent; parent && parent !== header; parent = parent.parent) {
            if (['blockquote', 'textarea', 'form'].includes(parent.name)) return false;
        }
        return ['(Hardcore)', '(In Ronin)'].includes(DomUtils.textContent(node).trim());
    });
}

export function recipientNeedsGift(html, recipientId) {
    return recipientGiftStatus(html, recipientId) === true;
}

export class KolTransport {
    constructor(username, password, client = null, log = console.log) {
        if (username?.toLowerCase() !== BOT_NAME.toLowerCase()) throw new Error('This worker is restricted to the kHub account.');
        if (!password && !client) throw new Error('Set KOL_PASSWORD in bot/.env.');
        this.client = client || new Client(username, password);
        this.log = log;
        this.retainedMail = new Set();
        this.nextRollover = null;
        this.nextRolloverRefreshAt = 0;
        this.needsGameInitialization = typeof this.client.session?.raw === 'function';
        this.client.on?.('login', () => { this.needsGameInitialization = true; });
    }
    async connect() {
        if (!await this.client.login()) {
            if (!this.client.isRollover?.()) throw new Error('KoL login failed.');
            this.log('KoL is down for rollover; waiting for maintenance to end before logging in.');
            await this.client.waitForRolloverEnd();
            if (!await this.client.login()) throw new Error('KoL login failed after rollover.');
        }
        await this.identity();
    }
    async readAccountStatus() {
        const status = await this.client.fetchStatus();
        if (Number(status.playerid) !== BOT_ID) throw new Error('Wrong KoL account: expected kHub (#3888760).');
        if (status.hardcore || status.roninleft > 0) throw new Error('kHub must be out of Hardcore/Ronin before processing escrow.');
        // The production client validates this Unix timestamp in ApiStatusSchema.
        if (Number.isSafeInteger(Number(status.rollover))) this.nextRollover = Number(status.rollover) * 1000;
        return status;
    }
    async identity() {
        let status = await this.readAccountStatus();
        if (this.needsGameInitialization) {
            // KoL permits API/mail access before completing ordinary page setup.
            // KoLmafia also visits main.php after login/time-in for this reason.
            // This read has no action parameters and never repeats an asset write.
            let page;
            try {
                page = await this.client.session.raw('main.php', {
                    method: 'GET', responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000,
                });
            } catch { throw new Error('KoL main-page login initialization failed; no transfer attempted by initialization.'); }
            if (page.status !== 200) throw new Error(`KoL main-page login initialization returned HTTP ${page.status}; no transfer attempted by initialization.`);
            this.needsGameInitialization = false;
        }
        const now = Date.now();
        if (this.nextRollover !== null && this.nextRollover <= now && now >= this.nextRolloverRefreshAt
            && typeof this.client.fetchText === 'function') {
            // API access can survive the day boundary without a login event.
            // Revisit the game page so that this session can enter the new day;
            // the read-only recovery wrapper waits/reconnects through maintenance.
            // An old timestamp never authorizes writes just because time passed.
            this.nextRolloverRefreshAt = now + 60000;
            this.log('KoL still reports a past rollover time; refreshing the game session before allowing transfers.');
            try {
                await this.client.fetchText('main.php', { method: 'GET', retry: 0, timeout: 20000 });
            } catch { throw new Error('KoL post-rollover session refresh failed; no transfer attempted by the refresh.'); }
            status = await this.readAccountStatus();
            this.needsGameInitialization = false;
            if (this.transfersAllowed()) this.log('KoL rollover session refreshed; transfers can resume after ledger and asset checks.');
        }
        return status;
    }
    rolloverPauseReason(now = Date.now()) {
        if (this.client.isRollover?.()) return 'KoL reports maintenance';
        if (this.nextRollover === null) return 'rollover time unavailable';
        return `reported rollover ${new Date(this.nextRollover).toISOString()}; current time ${new Date(now).toISOString()}`;
    }
    transfersAllowed(now = Date.now()) {
        // A read-only status refresh on the next cycle learns the new rollover.
        // No fixed local timezone or assumed maintenance duration is required.
        return !this.client.isRollover?.() && (this.nextRollover === null || this.nextRollover - now > 120000);
    }
    async prepareTransfers() {
        await this.identity();
        return this.transfersAllowed();
    }
    async openGiftPackage(wrapperId) {
        // Do not use the client's recovery wrapper for an asset-changing request.
        // A timeout is verified from updated KMail by the durable intake workflow.
        const allowed = [1167,1168,1169,1170,1171,1172,1173,1174,1175,1176,1177,1460,1534,2683,3430];
        if (!allowed.includes(wrapperId) || !this.transfersAllowed()) throw new Error('Gift open not authorized.');
        if (typeof this.client.session?.raw !== 'function') throw new Error('Single-attempt gift transport unavailable.');
        await this.client.session.raw('inv_use.php', { method: 'POST',
            body: new URLSearchParams({ whichitem: String(wrapperId), quantity: '1', ajax: '1' }),
            responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000 });
    }
    async inbox() {
        const raw = await readCompleteInbox(this.client);
        for (const mail of this.pendingGiftMails || []) {
            if (!raw.some(row => String(row.id) === mail.id)) raw.push(mail.raw.gift_original);
        }
        this.inboxComplete = true;
        this.reviewHolds = { meat: '0', items: {}, uncertain: false };
        return raw.map(mail => {
            try {
                if (this.bankedGiftIds?.has(String(mail.id))) return null;
                if (this.isolateIncomingGifts && mail.type === 'giftshop' && !this.openedGifts?.has(String(mail.id))) return null;
                const normalized = this.openedGifts?.get(String(mail.id)) || normalizeMail(mail, KmailMailbox.parse);
                if (normalized) return normalized;
            } catch {
                this.inboxComplete = false;
                // A malformed individual message cannot prevent other players' mail
                // from being processed. Failure context is separately redacted below.
            }
            // Preserve unrelated players' attached assets when calculating what
            // can be closeted. Unsupported/unreadable shapes defer closet moves.
            try {
                if (mail?.type !== 'normal') throw new Error('Unknown attachment format');
                const parsed = KmailMailbox.parse(mail.message, mail.type);
                if (parsed.insideNote !== null) throw new Error('Unknown attachment format');
                this.reviewHolds.meat = String(BigInt(this.reviewHolds.meat) + BigInt(whole(parsed.meat, 'review Meat')));
                for (const item of parsed.items) {
                    const itemId = whole(item.id, 'review item', 2147483647);
                    const quantity = whole(item.quantity, 'review quantity', 5000000000);
                    if (!itemId || !quantity) throw new Error('Invalid review attachment');
                    this.reviewHolds.items[itemId] = String(BigInt(this.reviewHolds.items[itemId] || 0) + BigInt(quantity));
                }
            } catch { this.reviewHolds.uncertain = true; }
            const id = /^[1-9][0-9]*$/.test(String(mail?.id)) ? String(mail.id) : 'unrecognized';
            if (!this.retainedMail.has(id)) {
                this.log(`Leaving KMail ${id} in the inbox for manual review; unsupported, unrelated, system, or malformed mail. No reply or deletion.`);
                logMailFailure(this.log, mail, 'Unsupported or malformed mail retained for review');
                if (this.retainedMail.size >= 1000) this.retainedMail.clear();
                this.retainedMail.add(id);
            }
            return null;
        }).filter(mail => mail !== null)
            .sort(compareMail);
    }
    async snapshot() {
        const status = await this.identity();
        const raw = await this.client.fetchJson('api.php', { query: { what: 'inventory', for: 'kHub escrow bot' }, timeout: 20000 });
        const items = Array.isArray(raw) && raw.length === 0 ? {} : raw;
        if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('Unrecognized inventory response.');
        whole(status.meat, 'inventory Meat');
        for (const [id, quantity] of Object.entries(items)) { whole(id, 'inventory item'); whole(quantity, 'inventory quantity'); }
        const snapshot = { meat: String(status.meat), items };
        if (this.giftProtectionActive && this.giftProtectionStore) {
            await this.giftProtectionStore.rpc('bot_refresh_gift_protection', { p_snapshot: { ...snapshot, reserve: this.giftOperatingReserve || 0 } });
        }
        return snapshot;
    }
    async closetSnapshot() {
        await this.identity();
        const status = await this.client.fetchJson('api.php', { query: { what: 'status', for: 'kHub escrow bot' }, timeout: 20000 });
        if (Number(status?.playerid) !== BOT_ID || String(status.hardcore) === '1' || Number(status.roninleft) > 0) throw new Error('Unexpected account status for closet snapshot.');
        const inventory = await this.client.fetchJson('api.php', { query: { what: 'inventory', for: 'kHub escrow bot' }, timeout: 20000 });
        const closet = await this.client.fetchJson('api.php', { query: { what: 'closet', for: 'kHub escrow bot' }, timeout: 20000 });
        const validate = raw => {
            const items = Array.isArray(raw) && raw.length === 0 ? {} : raw;
            if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('Unexpected item balances.');
            for (const [id, quantity] of Object.entries(items)) {
                if (!whole(id, 'balance item', 2147483647)) throw new Error('Invalid item balance ID');
                whole(quantity, 'item balance');
            }
            return items;
        };
        return { meat: String(whole(status.meat, 'inventory Meat')), closetMeat: String(whole(status.closetmeat, 'closet Meat')),
            items: validate(inventory), closetItems: validate(closet) };
    }
    async postChatAnnouncement(channel, message, { shouldStop = () => false } = {}) {
        if (!/^[a-z][a-z0-9_-]{0,29}$/.test(channel) || typeof message !== 'string' || message.startsWith('/')
            || /[\r\n]/.test(message) || message.includes('&&') || [...`/${channel} ${message}`].length > 255) throw Error('Invalid chat announcement.');
        if (shouldStop() || this.transfersAllowed() === false) return 'deferred';
        await this.identity();
        const request = async graf => {
            if (shouldStop() || this.transfersAllowed() === false) return null;
            // Same endpoint and explicit channel routing as KoL chat/KoLmafia.
            // Avoid fetchJson's login recovery: a chat write must never be replayed.
            return this.client.session.raw('submitnewchat.php', {
                method: 'GET', query: { graf, j: '1', playerid: String(BOT_ID) },
                responseType: 'json', retry: 0, redirect: 'manual', timeout: 5000,
            });
        };
        const joined = await request(`/channel ${channel}`);
        if (joined?.status !== 200) return 'unconfirmed';
        const sent = await request(`/${channel} ${message}`);
        const echo = sent?.status === 200 && Array.isArray(sent._data?.msgs) && sent._data.msgs.some(msg =>
            msg.type === 'public' && String(msg.who?.id) === String(BOT_ID) && msg.channel === channel
            && DomUtils.textContent(parseDocument(String(msg.msg || ''))).trim() === message);
        return echo ? 'confirmed' : 'unconfirmed';
    }
    async diagnoseCloset() {
        const pages = [];
        for (const path of ['closet.php', 'fillcloset.php', 'inventory.php']) {
            // No action, item, quantity or form submission: read the pages only.
            const raw = await this.client.session.raw(path, {
                method: 'GET', responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000,
            });
            const doc = parseDocument(String(raw._data ?? ''));
            const forms = selectAll('form', doc).map(form => ({
                action: safePage(form.attribs.action || path),
                method: String(form.attribs.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
                fields: [...new Set(selectAll('input, select, button', form)
                    .map(node => node.attribs.name).filter(name => /^(action|whichitem\d*|qty|quantity|howmany\d*|howmuch|addtake|ajax|which|pwd)$/.test(name || '')))],
                actions: selectAll('input[name="action"]', form).map(node => node.attribs.value)
                    .filter(value => /^(closetpush|closetpull|addtakeclosetmeat|put|take|putmeat|takemeat|pullallcloset)$/.test(value || '')),
            }));
            pages.push({ path, httpStatus: raw.status,
                redirectPath: raw.headers.get('location') ? safePage(raw.headers.get('location')) : null,
                forms });
        }
        return { mode: 'read-only diagnostic; no transfers attempted', pages };
    }
    async depositCloset(operation) {
        const meat = whole(operation.meat, 'closet transfer Meat', 1000000000);
        const quantity = whole(operation.quantity, 'closet transfer quantity', 1000000000);
        const itemId = operation.item_id == null ? null : whole(operation.item_id, 'closet transfer item', 2147483647);
        if (!((meat > 0 && itemId === null && quantity === 0) || (meat === 0 && itemId > 0 && quantity > 0))) throw new Error('Invalid closet transfer shape.');
        const beforeInventory = BigInt(whole(operation.before_state?.inventory, 'pre-transfer inventory'));
        const beforeCloset = BigInt(whole(operation.before_state?.closet, 'pre-transfer closet'));
        const amount = BigInt(itemId === null ? meat : quantity);
        if (beforeInventory < amount) throw new Error('Invalid pre-transfer inventory.');
        const path = itemId === null ? 'closet.php' : 'fillcloset.php';
        const method = itemId === null ? 'POST' : 'GET';
        // Return redirects without following them. A closet action may redirect
        // after changing inventory; only the independent balance check proves it.
        const options = { method, responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000 };
        if (itemId === null) {
            options.body = new URLSearchParams({ action: 'addtakeclosetmeat', addtake: 'add', quantity: String(meat) });
        } else {
            // KoL's item closet action uses GET query parameters. This GET changes
            // inventory: use the raw session once, with no recovery/retry wrapper.
            options.query = { action: 'closetpush', whichitem: String(itemId), qty: String(quantity), ajax: '1' };
        }
        let response;
        let httpStatus = null;
        let redirectPath = null;
        try {
            if (this.client.session.raw) {
                const raw = await this.client.session.raw(path, options);
                response = raw._data ?? '';
                httpStatus = raw.status;
                const location = raw.headers.get('location');
                if (location) {
                    redirectPath = safePage(location);
                }
            } else response = await this.client.session(path, options);
        }
        catch (error) {
            const causes = [];
            for (let cause = error, depth = 0; cause && depth < 4; cause = cause.cause, depth++) {
                const name = ['FetchError', 'TypeError', 'AbortError', 'TimeoutError', 'Error'].includes(cause.name) ? cause.name : 'OtherError';
                const code = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(cause.code) ? cause.code : null;
                causes.push({ name, code });
            }
            throw new ClosetTransferError({ stage: 'request', path, method,
                httpStatus: Number.isInteger(error?.response?.status) ? error.response.status : null,
                causes, before: operation.before_state });
        }
        const responseHash = createHash('sha256').update(String(response)).digest('hex');
        let after;
        try { after = await this.closetSnapshot(); }
        catch { throw new ClosetTransferError({ stage: 'readback', path, method, httpStatus, redirectPath, responseHash, before: operation.before_state }); }
        const inventory = BigInt(itemId === null ? after.meat : after.items[itemId] || 0);
        const closet = BigInt(itemId === null ? after.closetMeat : after.closetItems[itemId] || 0);
        // New incoming mail may increase inventory during the request. The exact
        // closet increase proves this move; never accept missing inventory.
        if (closet !== beforeCloset + amount || inventory < beforeInventory - amount) throw new ClosetTransferError({
            stage: 'balance_mismatch', path, method, httpStatus, redirectPath, responseHash, before: operation.before_state,
            expected: { minimumInventory: String(beforeInventory - amount), closet: String(beforeCloset + amount) },
            after: { inventory: String(inventory), closet: String(closet) },
        });
        return JSON.stringify({ before: operation.before_state, after: { inventory: String(inventory), closet: String(closet) } });
    }
    async findSentDeliveries(deliveries) {
        // GET reads only: no deletion, forwarding, send action or recovery write.
        // Scan once per batch, bounded to ten pages. Missing mail is never proof
        // of a failed send; page/HTTP/parse failures produce manual review.
        await this.identity();
        const messages = new Map();
        let page = 1;
        try {
            for (let count = 0; count < 10; count++) {
                const options = { method: 'GET', query: { box: 'Sent', begin: String(page) },
                    responseType: 'text', retry: 0, redirect: 'manual', timeout: 20000 };
                const raw = this.client.session.raw
                    ? await this.client.session.raw('messages.php', options)
                    : { status: 200, _data: await this.client.session('messages.php', options) };
                if (raw.status !== 200) throw new Error('Sent Mail unavailable.');
                const parsed = parseSentPage(raw._data);
                for (const message of parsed.messages) {
                    const previous = messages.get(message.id);
                    if (previous && JSON.stringify(previous) !== JSON.stringify(message)) throw new Error('Conflicting Sent Mail records.');
                    messages.set(message.id, message);
                }
                if (parsed.next === null) break;
                if (parsed.next <= page) throw new Error('Unrecognized Sent Mail pagination.');
                page = parsed.next;
            }
            return deliveries.map(delivery => ({ id: delivery.id,
                ...matchSentDelivery(delivery, [...messages.values()]) }));
        } catch {
            // No raw HTML, URLs, message bodies, credentials or fetch error text.
            return deliveries.map(delivery => ({ id: delivery.id, status: 'check_failed',
                candidate_ids: matchSentDelivery(delivery, [...messages.values()]).candidate_ids }));
        }
    }
    async acknowledge(id) {
        // Only called after PostgreSQL confirms the recognized request was accepted
        // and all of its immediate replies/refunds were acknowledged as sent.
        if (!await this.client.kmail.delete([Number(id)])) throw new Error('KMail deletion could not be confirmed. Its durable receipt prevents reprocessing.');
    }
    async recipientGiftStatus(recipientId) {
        if (typeof this.client.session?.raw !== 'function') return null;
        try {
            const profile = await this.client.session.raw('showplayer.php', {
                method: 'GET', query: { who: String(recipientId) }, responseType: 'text',
                retry: 0, redirect: 'manual', timeout: 20000,
            });
            return profile?.status === 200 ? recipientGiftStatus(profile._data, recipientId) : null;
        } catch { return null; }
    }
    async send(delivery, { authorizeGift = null } = {}) {
        // Do not use kmail.send()/fetchText(): recovery wrappers may reissue a
        // write after a redirect. One raw session request, retry=0, no redirects.
        if (delivery.display_message != null && (
            !/^D-[1-9][0-9]*$/.test(delivery.delivery_reference || '')
            || delivery.reference_marker !== `Reference: ${delivery.delivery_reference}`
        )) throw new Error('Invalid delivery reference; inspect before sending.');
        await this.identity();
        const body = new URLSearchParams({ action: 'send', towho: String(delivery.recipient_id),
            contact: '0', savecopy: 'on', sendmeat: String(delivery.meat),
            message: delivery.display_message != null
                ? `${delivery.display_message}\n\n${delivery.reference_marker}${delivery.display_footer ? `\n${delivery.display_footer}` : ''}`
                : `${delivery.message}\n[kHub delivery ${delivery.id}]` });
        if (delivery.item_id) {
            body.set('whichitem1', String(delivery.item_id));
            body.set('howmany1', String(delivery.quantity));
        }
        const hasAssets = BigInt(delivery.meat || 0) > 0n || Boolean(delivery.item_id);
        if (hasAssets && typeof this.client.session.raw === 'function') {
            // Fresh read on every delivery: a player may ascend between bids.
            // No profile cache, game mutation, login recovery, or asset retry.
            let profile;
            try {
                profile = await this.client.session.raw('showplayer.php', {
                    method: 'GET', query: { who: String(delivery.recipient_id) }, responseType: 'text',
                    retry: 0, redirect: 'manual', timeout: 20000,
                });
            } catch { /* A failed read grants no permission to send twice. */ }
            if (profile?.status === 200 && recipientNeedsGift(profile._data, delivery.recipient_id)) {
                return this.sendGift(delivery, body.get('message'), authorizeGift, 'recipient profile shows Hardcore/Ronin',
                    createHash('sha256').update(profile._data).digest('hex'));
            }
        }
        let html;
        let sendHttpStatus = null;
        try {
            html = await this.client.session('sendmessage.php', {
                method: 'POST', body, responseType: 'text', retry: 0, redirect: 'error', timeout: 20000,
                onResponse: ({response}) => { sendHttpStatus = response.status; },
            });
        } catch (error) {
            const status = error?.response?.status ?? sendHttpStatus;
            throw new MailDeliveryError('request_failed', null, mailResponseDiagnostic(error?.response?._data ?? '', delivery, status));
        }
        // Conservative positive acknowledgment. Unknown/changed pages are NOT
        // success. The sent-copy marker lets an operator resolve uncertainty.
        if (/<center>\s*Message sent(?:\.|!|<|\s)/i.test(html)) {
            return `KoL send acknowledgment; response SHA256 ${createHash('sha256').update(html).digest('hex')}`;
        }
        // Only an explicit game rejection authorizes another asset request.
        // A timeout, redirect, changed page, or generic failure never does.
        const rejection = confirmedMailRejection(html);
        if (!rejection || !hasAssets) {
            throw new MailDeliveryError('response_unrecognized', createHash('sha256').update(String(html)).digest('hex'),
                mailResponseDiagnostic(html, delivery, sendHttpStatus));
        }
        return this.sendGift(delivery, body.get('message'), authorizeGift, `regular KMail explicitly rejected (${rejection}); trying gift fallback once`,
            createHash('sha256').update(html).digest('hex'));
    }
    async sendGift(delivery, message, authorizeGift, reason, selectionHash) {
        // Current KoLmafia packages.txt: plain brown wrapper, radio 1, one
        // item type (any quantity), 50 Meat. Never deduct this from the refund.
        if (typeof authorizeGift !== 'function') throw new Error('Gift wrapping requires an operating-funds check.');
        let payer = 'bot';
        try {
            const authorization = await authorizeGift(50);
            if (authorization?.payer === 'buyer') payer = 'buyer';
            await this.identity();
            if (this.nextRollover !== null && !this.transfersAllowed()) throw new Error('Rollover');
        } catch (error) { if (error instanceof GiftBudgetDeferredError) throw error; throw new GiftDeliveryError('not_attempted'); }
        // Gift-shop notes do not preserve KMail's multiline formatting: live
        // packages displayed paragraph breaks as stray 'nn'. Keep the saved
        // message unchanged; flatten only this outgoing gift-note copy. Plain
        // separators work in both the outer note and the opened package.
        const note = message.replace(/\r\n?|\n/g, '\n').split(/\n+/)
            .map(line => line.trim()).filter(Boolean).join(' | ');
        const gift = new URLSearchParams({ action: 'Yep.', towho: String(delivery.recipient_id),
            whichpackage: '1', fromwhere: '0', sendmeat: String(delivery.meat || 0),
            note, insidenote: note, savecopy: 'on' });
        if (delivery.item_id) {
            gift.set('whichitem1', String(delivery.item_id));
            gift.set('howmany1', String(delivery.quantity));
        }
        this.log(`Delivery ${delivery.delivery_reference || delivery.id}: ${reason}; sending the same assets as a gift package (50 Meat wrapping paid by ${payer === 'buyer' ? 'the buyer’s escrow' : 'kHub'}).`);
        let giftHtml;
        try {
            giftHtml = await this.client.session('town_sendgift.php', {
                method: 'POST', body: gift, responseType: 'text', retry: 0, redirect: 'error', timeout: 20000,
            });
        } catch { throw new GiftDeliveryError(); }
        if (!/<td>\s*Package sent\.\s*<\/td>/i.test(giftHtml)) throw new GiftDeliveryError();
        return `KoL gift-package acknowledgment; wrapping cost 50 Meat paid by ${payer === 'buyer' ? 'buyer escrow' : 'kHub'}; gift selection SHA256 ${selectionHash}; response SHA256 ${createHash('sha256').update(giftHtml).digest('hex')}`;
    }
}
