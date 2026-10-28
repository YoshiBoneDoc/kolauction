import { closetIncome } from './closet.mjs';
import { assertSolvent, GiftDeliveryError, GiftBudgetDeferredError, MailDeliveryError } from './protocol.mjs';
import { processAccountMail } from './accounts.mjs';
import { compareMail } from './inbox.mjs';
import { createOperatorLogs, deliveryPurpose, deliveryAssets, reference } from './operator-logs.mjs';
export class EscrowWorker {
    constructor({ store, transport, live = false, reserve = 0, log = console.log, pause = async () => {}, shouldStop = () => false, notifyPlayerOnAccountFailure = true }) {
        Object.assign(this, { store, transport, live, reserve, log, pause, shouldStop, notifyPlayerOnAccountFailure });
        this.notifiedAccountFailures = new Set();
        this.operatorLogs = createOperatorLogs(message => this.log(message));
    }
    async cycle() {
        try { return await this.runCycle(); }
        catch (error) {
            if (this.live) {
                try { await this.notifyManualReview(); }
                catch { this.log('Could not confirm a manual-review notice. Inspect the delivery ledger; no automatic resend.'); }
            }
            throw error;
        }
    }
    async notifyManualReview() {
        if (this.shouldStop()) return;
        if (this.transport.prepareTransfers && !await this.transport.prepareTransfers()) {
            this.log('KoL rollover is near/in progress; manual-review notices will wait.');
            return;
        }
        for (let n = 0; n < 100; n++) {
            if (this.shouldStop()) return;
            if (this.transport.transfersAllowed?.() === false) return;
            const notice = await this.store.rpc('bot_claim_review_notice');
            if (!notice) return;
            if (notice.kind !== 'notice' || BigInt(notice.meat) !== 0n || notice.item_id != null || BigInt(notice.quantity || 0) !== 0n) {
                throw new Error('Manual-review notices must contain no assets. Inspect the claim.');
            }
            await this.sendDelivery(notice);
            await this.pause();
        }
    }
    async recoverMailbox({ force = false } = {}) {
        if (!this.mailboxRecoveryEnabled || typeof this.transport.findSentDeliveries !== 'function') return false;
        if (!force && Date.now() < (this.nextMailboxCheckAt || 0)) return false;
        this.nextMailboxCheckAt = Date.now() + 300000;
        const rows = await this.store.rpc('bot_mailbox_check_deliveries');
        if (!Array.isArray(rows)) throw new Error('Invalid mailbox recovery queue; no automatic resend.');
        if (!rows.length) return true;
        let results;
        try { results = await this.transport.findSentDeliveries(rows); }
        catch { results = []; }
        for (const delivery of rows) {
            if (this.shouldStop()) return false;
            const result = Array.isArray(results) ? results.find(row => row.id === delivery.id) : null;
            const checked = result && ['verified', 'not_found', 'ambiguous', 'check_failed'].includes(result.status)
                ? result : { status: 'check_failed', candidate_ids: [] };
            const outcome = await this.store.rpc('bot_record_mailbox_check', {
                p_id: delivery.id, p_attempt: delivery.attempt, p_result: checked,
            });
            const label = delivery.delivery_reference || delivery.id;
            if (outcome?.status === 'sent') this.log(`Delivery ${label} confirmed in KoL Sent Mail (message ID ${outcome.message_id}); no resend.`);
            else if (outcome?.status === 'isolated') this.log(`Delivery ${label} set aside; administrator alert recorded. Other funded deliveries continue; no automatic resend.`);
            else if (outcome?.status !== 'already_sent') throw new Error('Mailbox recovery was not recorded; no automatic resend.');
        }
        // Conservatively defer closet income until the next inspection confirms
        // that every uncertain obligation has been resolved.
        this.hasUncertainDeliveries = true;
        return true;
    }
    async runCycle() {
        let report = await this.store.rpc('bot_inspect');
        this.mailboxRecoveryEnabled = this.live && report.mailboxRecoveryEnabled === true;
        if (this.mailboxRecoveryEnabled && report.attention?.length) {
            const knownIsolated = new Set((report.isolatedDeliveryAttention || []).map(row => row.id));
            const newUncertainty = report.attention.some(row => !knownIsolated.has(row.id));
            if (await this.recoverMailbox({ force: newUncertainty })) report = await this.store.rpc('bot_inspect');
        }
        this.hasUncertainDeliveries = Boolean(report.attention?.length);
        const isolatedIds = new Set(this.mailboxRecoveryEnabled ? (report.isolatedDeliveryAttention || []).map(row => row.id) : []);
        const blocking = report.attention.filter(row => !isolatedIds.has(row.id));
        if (this.shouldStop()) return { state: 'stopping' };
        this.closetIsolationEnabled = report.closetIsolationVersion === 1;
        if (report.closetAttention?.length && !this.closetIsolationEnabled) {
            this.log(`Closet transfers need operator reconciliation; all asset transfers are stopped. ${report.closetAttention.map(c => `${c.closet_reference} (UUID ${c.id})`).join(', ')}`);
            return { state: 'blocked' };
        }
        if (report.closetAttention?.length && this.closetIsolationEnabled && this.live) {
            const key = report.closetAttention.map(c => `${c.id}:${c.attempt || ''}`).sort().join(',');
            if (this.closetReviewKey !== key) {
                try {
                    await this.store.rpc('bot_isolate_closet_transfers');
                    this.closetReviewKey = key;
                    this.log('Uncertain closet moves set aside for review; other funded deliveries and unrelated closet assets continue. No automatic retry.');
                } catch { this.log('Closet review notice deferred; unrelated auction work continues.'); }
            }
        }
        if (blocking.length) {
            const blocked = blocking.map(d => d.delivery_reference ? `${d.delivery_reference} (UUID ${d.id})` : d.id).join(', ');
            if (this.live) await this.notifyManualReview();
            this.log(`Uncertain deliveries require operator reconciliation; automatic transfers are stopped. ${blocked}`);
            return { state: 'blocked' };
        }
        // Bound package sweeping to inventory observed before this inbox batch.
        // New arrivals after the snapshot are deferred to a later batch.
        this.transport.giftProtectionActive = false;
        this.giftIsolationEnabled = report.giftIsolationVersion === 1;
        if (this.live) this.packageBudget = { ...(await this.transport.snapshot()).items };
        const receiptTimeBidding = report.receiptTimeBiddingVersion === 1;
        const inboxScan = this.live && receiptTimeBidding ? await this.store.rpc('bot_begin_inbox_scan') : null;
        if (this.live && report.incomingGiftsVersion >= 1) {
            const gifts = await import('./incoming-gifts.mjs');
            if (!await (this.giftIsolationEnabled ? gifts.prepareIsolatedGifts(this) : gifts.prepareIncomingGifts(this))) return { state: 'stopping' };
        }
        const mails = await this.transport.inbox();
        if (!this.live) {
            this.log(JSON.stringify({ mode: 'read-only', messages: mails.map(({ id, command, meat, items }) => ({
                id, command: command.type === 'verify' ? { type: 'verify', token: '[redacted]' } : command, meat, items,
            })), report }));
            return { state: 'read-only' };
        }
        if (receiptTimeBidding && this.transport.inboxComplete !== true) {
            this.log('Inbox scan contains unreadable messages; escrow finalization and this intake batch are held for review. No winner or payout was declared.');
            return { state: 'blocked' };
        }
        let recognized = mails.filter(mail => ['verify','list','bid','bid_help','buy','fund','fill','donation','register','credentials'].includes(mail.command?.type)
            || (mail.command?.type === 'unknown' && (mail.meat > 0 || mail.items?.length > 0)));
        if (receiptTimeBidding) {
            if (!inboxScan?.id) throw new Error('Invalid database inbox-scan response; no settlement.');
            const pending = await this.store.rpc('bot_stage_inbox_scan', { p_scan_id: inboxScan.id, p_mails: recognized });
            if (!Array.isArray(pending)) throw new Error('Invalid durable bid queue; no settlement.');
            const merged = new Map(recognized.map(mail => [mail.id, mail]));
            for (const mail of pending) merged.set(mail.id, mail);
            recognized = [...merged.values()].sort(compareMail);
        }
        const attemptedAccounts = new Set();
        const deferredAccounts = new Set();
        const failedAccounts = new Set();
        const accountDeadline = Date.now() + 20000;
        let accountAttempts = 0;
        const processAccount = async mail => {
            if (attemptedAccounts.has(mail.id)) return;
            attemptedAccounts.add(mail.id);
            this.operatorLogs.received(mail);
            // A busy signup queue gets at most two requests per cycle. Once
            // an account call stalls, proceed to auction work instead.
            if (accountAttempts >= 2 || Date.now() >= accountDeadline) {
                deferredAccounts.add(mail.id);
                return;
            }
            accountAttempts++;
            let receiptRecorded = false;
            try {
                await processAccountMail(this.store, mail, { onReceiptRecorded: () => { receiptRecorded = true; } });
            } catch (error) {
                this.operatorLogs.failure(mail, 'Account processing failed; request retained');
                // Unknown asset intake must still stop financial processing.
                // Auth failures after preparation are independent of transfers.
                if (!receiptRecorded && (BigInt(mail.meat || 0) > 0n || mail.items?.length)) throw error;
                deferredAccounts.add(mail.id);
                failedAccounts.add(mail.id);
                // Raw errors may contain account/password/request information.
                const label = /^[1-9][0-9]*$/.test(String(mail.id)) ? `KMail ${mail.id}` : 'Account request';
                this.log(`${label}: account processing deferred; retained for retry. Auction processing will continue.`);
            }
        };
        if (report.accountRequestsPending > 0) {
            let pendingAccounts = [];
            try {
                const data = await this.store.rpc('bot_pending_account_requests');
                if (!Array.isArray(data)) throw new Error('Invalid pending account response.');
                pendingAccounts = data;
            }
            catch {
                this.log('Pending account requests could not be loaded; retrying next cycle. Auction processing will continue.');
            }
            for (const mail of pendingAccounts) {
                if (this.shouldStop()) return { state: 'stopping' };
                await processAccount(mail);
            }
        }
        for (const mail of recognized) {
            if (this.shouldStop()) return { state: 'stopping' };
            if (['register','credentials'].includes(mail.command.type)) {
                await processAccount(mail);
                continue;
            }
            this.operatorLogs.received(mail);
            const donation = mail.command.type === 'donation';
            let result;
            try { result = await this.store.rpc(donation ? 'bot_ingest_donation' : 'bot_ingest_mail', { p_mail: mail }); }
            catch (error) {
                this.operatorLogs.failure(mail, 'Database intake not confirmed; no acceptance reported');
                throw error;
            }
            this.operatorLogs.outcome(mail, result);
        }
        for (const mailId of failedAccounts) {
            if (this.shouldStop()) return { state: 'stopping' };
            if (this.notifiedAccountFailures.has(mailId)) continue;
            try {
                const result = await this.store.rpc('bot_notify_account_failure', {
                    p_mail_id: mailId, p_notify_player: this.notifyPlayerOnAccountFailure,
                });
                if (['queued', 'already_queued', 'not_pending', 'restricted'].includes(result?.status)) this.notifiedAccountFailures.add(mailId);
            } catch {
                this.log('Account-failure notification was not confirmed; retained for retry. Check migration 059 if this persists.');
            }
        }
        if (report.mailPolicyAttention?.length && !this.hasUncertainDeliveries && !report.closetAttention?.length) {
            await this.store.rpc('bot_queue_previous_donation_refunds', { p_snapshot: await this.transport.snapshot() });
        }
        if (this.shouldStop()) return { state: 'stopping' };
        if (receiptTimeBidding) await this.store.rpc('bot_finish_inbox_scan', { p_scan_id: inboxScan.id });
        await this.store.rpc('bot_tick');
        if (report.buyDeliveryBatchingVersion === 1) await this.prepareBuyDeliveries();
        this.transport.giftProtectionActive = this.giftIsolationEnabled;
        for (let n = 0; n < 100; n++) {
            if (this.shouldStop()) return { state: 'stopping' };
            const snapshot = await this.transport.snapshot();
            const liabilities = await this.store.rpc(this.mailboxRecoveryEnabled ? 'bot_dispatch_liabilities' : 'bot_liabilities');
            assertSolvent(snapshot, liabilities, this.reserve);
            if (this.shouldStop()) return { state: 'stopping' };
            if (this.transport.transfersAllowed?.() === false) {
                const reason = this.transport.rolloverPauseReason?.();
                this.log(`KoL rollover is near/in progress${reason ? ` (${reason})` : ''}; queued transfers and mail cleanup will resume after maintenance. Intake already recorded is safe.`);
                this.rolloverPaused = true;
                return { state: 'rollover' };
            }
            if (this.rolloverPaused) {
                this.log('KoL rollover pause ended; resuming queued transfers and mail cleanup.');
                this.rolloverPaused = false;
            }
            const delivery = await this.store.rpc('bot_claim_delivery', { p_message_version: report.incomingGiftsVersion >= 2 ? 5 : report.incomingGiftsVersion === 1 ? 4 : report.buyDeliveryBatchingVersion === 1 ? 3 : 2 });
            if (!delivery) break;
            await this.sendDelivery(delivery);
            await this.pause();
        }
        if (this.hasUncertainDeliveries) this.log('Closet transfers deferred while isolated deliveries await a Sent Mail check. Other funded deliveries continue.');
        else if (this.closetIsolationEnabled) {
            try { await closetIncome(this); }
            catch {
                // A durable moving/unknown claim prevents a second attempt.
                // Preserve intake cleanup even when an optional closet move fails.
                this.log('Closet processing deferred after a failure; other auction work continues. Inspect closetAttention for any uncertain move.');
                try { await this.store.rpc('bot_isolate_closet_transfers'); }
                catch { this.log('Closet review notice could not be recorded; retained for the next inspection.'); }
            }
        } else await closetIncome(this);
        const ids = recognized.filter(mail => mail.raw?.type !== 'giftshop' && !deferredAccounts.has(mail.id)).map(mail => mail.id);
        if (ids.length) {
            const cleanup = await this.store.rpc('bot_mail_cleanup', { p_mail_ids: ids });
            if (!Array.isArray(cleanup) || cleanup.some(id => !ids.includes(id))) throw new Error('Invalid mail cleanup response; inbox left untouched.');
            for (const id of cleanup) {
                if (this.shouldStop()) return { state: 'stopping' };
                if (this.transport.transfersAllowed?.() === false) return { state: 'rollover' };
                try { await this.transport.acknowledge(id); }
                catch { this.log(`KMail ${id} could not be deleted; its committed receipt prevents duplicate processing. Leaving it for a later cleanup attempt.`); }
                await this.pause();
            }
        }
        return { state: this.transport.transfersAllowed?.() === false ? 'rollover' : 'healthy' };
    }
    async prepareBuyDeliveries() {
        const groups = await this.store.rpc('bot_pending_buy_delivery_groups');
        if (!Array.isArray(groups)) throw new Error('Invalid Buy delivery batch list; no dispatch.');
        for (const group of groups) {
            if (this.shouldStop()) return;
            const status = await this.transport.recipientGiftStatus(group.recipient_id);
            await this.store.rpc('bot_prepare_buy_delivery', {
                p_auction_id: group.auction_id, p_needs_gift: status,
            });
            if (status === null) this.log('Buy item delivery is held until the recipient profile can be verified. Other deliveries continue.');
        }
    }
    async sendDelivery(delivery) {
        const label = delivery.delivery_reference ? `${delivery.delivery_reference} (UUID ${delivery.id})` : delivery.id;
        const shortLabel = reference(delivery);
        const purpose = deliveryPurpose(delivery);
        const auctionNumber = String(delivery.display_message || '').match(/(?:^|\n)Auction #([1-9][0-9]*)\b/)?.[1];
        this.log(`[MAIL ${shortLabel}] Sending ${purpose} → ${this.operatorLogs.player(delivery.recipient_id)}${auctionNumber ? ` · Auction #${auctionNumber}` : ''}${deliveryAssets(delivery) === 'no attachments' ? '' : ` · ${deliveryAssets(delivery)}`}.`);
        if (process.env.BOT_LOG_DETAILS === 'true') this.log(`[DETAIL ${shortLabel}] Delivery UUID ${delivery.id}${delivery.auction_id ? `; auction UUID ${delivery.auction_id}` : ''}.`);
        let evidence;
        const buyItemDelivery = delivery.kind === 'sale_item' && delivery.dedupe_key?.startsWith('buy-');
        try { evidence = await this.transport.send(delivery, { authorizeGift: async cost => {
            if (this.shouldStop()) throw new Error('Gift delivery deferred while stopping.');
            const review = this.transport.reviewHolds || { meat: '0', uncertain: false };
            if (review.uncertain) throw new Error('Gift wrapping deferred while unreadable inbox attachments need review.');
            // Wrapping must use genuinely spare Meat, never any player's funds
            // or the reserve. Full liabilities also retain isolated obligations.
            let payer = 'bot';
            if (buyItemDelivery) {
                const authorization = await this.store.rpc('bot_charge_buy_gift', { p_id: delivery.id, p_attempt: delivery.attempt });
                if (!authorization?.authorized || authorization.payer !== 'bot') throw new GiftBudgetDeferredError();
                payer = authorization.payer;
            }
            const snapshot = await this.transport.snapshot();
            const liabilities = await this.store.rpc('bot_gift_wrapping_liabilities');
            assertSolvent(snapshot, liabilities,
                BigInt(this.reserve) + BigInt(review.meat || 0) + BigInt(cost));
            if (this.giftIsolationEnabled) await this.store.rpc('bot_authorize_safe_gift_wrapping', { p_id: delivery.id, p_attempt: delivery.attempt });
            return { payer };
        } }); }
        catch (error) {
            if (this.giftIsolationEnabled && (error instanceof GiftBudgetDeferredError || error instanceof GiftDeliveryError && error.outcome === 'not_attempted')) {
                await this.store.rpc('bot_release_safe_gift_wrapping', { p_id: delivery.id, p_attempt: delivery.attempt });
            }
            if (buyItemDelivery && (error instanceof GiftBudgetDeferredError || error instanceof GiftDeliveryError && error.outcome === 'not_attempted')) {
                await this.store.rpc('bot_defer_buy_delivery', { p_id: delivery.id, p_attempt: delivery.attempt });
                this.log(`Delivery ${label}: no gift request attempted; items remain queued; kHub packaging funds or batch preparation will be checked again. Other deliveries continue.`);
                return;
            }
            this.log(`[REVIEW ${shortLabel}] ${purpose}: send not confirmed. No automatic resend; recovery checks or review required.`);
            this.operatorLogs.failureForReceipt(delivery.receipt_id, `Delivery ${shortLabel} not confirmed`);
            if (error instanceof MailDeliveryError && error.diagnostic) this.log(`[DETAIL ${shortLabel}] ${JSON.stringify(error.diagnostic)}`);
            // Even a timeout may mean KoL sent the transfer. Never retry it.
            try {
                await this.store.rpc('bot_ack_delivery', { p_id: delivery.id, p_attempt: delivery.attempt, p_sent: false,
                    p_evidence: error instanceof GiftDeliveryError
                        ? error.outcome === 'not_attempted'
                            ? 'Gift delivery was selected, but no gift was attempted because its funds or rollover check did not pass. Inspect before a manual retry.'
                            : 'Gift package outcome uncertain. Check recipient gift packages and the delivery reference before reconciling; no automatic resend.'
                        : error instanceof MailDeliveryError ? error.evidence
                            : 'Send outcome uncertain. Inspect the saved sent-copy delivery marker before reconciling.' });
            } catch {
                throw new Error(`Delivery ${label}: send outcome uncertain and database acknowledgment failed. Inspect before retrying; no automatic resend.`);
            }
            if (await this.recoverMailbox({ force: true })) return;
            throw new Error(`Delivery ${label} needs reconciliation; no automatic resend.`);
        }
        // If this DB acknowledgment fails, the durable row stays sending.
        // Restart will stop for reconciliation, rather than paying twice.
        try {
            await this.store.rpc('bot_ack_delivery', { p_id: delivery.id, p_attempt: delivery.attempt, p_sent: true, p_evidence: evidence });
        } catch (error) {
            if (await this.recoverMailbox({ force: true })) return;
            this.operatorLogs.failureForReceipt(delivery.receipt_id, `Delivery ${shortLabel}: database acknowledgment failed`);
            throw new Error(`Delivery ${label}: database acknowledgment failed (${error.message}). Inspect before retrying; the delivery remains blocked.`);
        }
        if (this.packageBudget && delivery.item_id) {
            const remaining = BigInt(this.packageBudget[delivery.item_id] || 0) - BigInt(delivery.quantity || 0);
            this.packageBudget[delivery.item_id] = String(remaining > 0n ? remaining : 0n);
        }
        this.log(`[MAIL ${shortLabel}] Send acknowledged · ${purpose} → ${this.operatorLogs.player(delivery.recipient_id)}.`);
    }
}
