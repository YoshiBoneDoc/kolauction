import { assertSolvent } from './protocol.mjs';
import { assets, reference } from './operator-logs.mjs';

// Diagnostic fields are constructed here/inside the adapter, never from raw
// fetch errors, which can contain session tokens in request URLs.
export class ClosetTransferError extends Error {
    constructor(diagnostic) {
        super('Closet transfer outcome could not be confirmed.');
        this.diagnostic = diagnostic;
    }
}

export async function closetIncome({ store, transport, reserve, pause, log, packageBudget, operatorLogs, shouldStop = () => false }) {
    if (shouldStop()) return;
    const review = transport.reviewHolds || { meat: '0', items: {}, uncertain: false };
    if (review.uncertain) {
        log('Closet transfers deferred: unreadable inbox attachments need manual review. Auction processing can continue.');
        return;
    }
    let snapshot = await transport.closetSnapshot();
    if (transport.transfersAllowed?.() === false) {
        log('Closet transfers deferred until after KoL rollover.');
        return;
    }
    const packageInventory = packageBudget ? Object.fromEntries(Object.entries(snapshot.items).map(([id, quantity]) => {
        const observed = BigInt(packageBudget[id] || 0);
        return [id, String(BigInt(quantity) < observed ? BigInt(quantity) : observed)];
    })) : snapshot.items;
    await store.rpc('bot_queue_gift_packages', { p_inventory: packageInventory, p_review_items: review.items });
    for (let n = 0; n < 100; n++) {
        if (shouldStop()) return;
        assertSolvent(snapshot, await store.rpc('bot_liabilities'), reserve);
        if (shouldStop()) return;
        if (transport.transfersAllowed?.() === false) {
            log('Closet transfers deferred until after KoL rollover.');
            return;
        }
        const operation = await store.rpc('bot_claim_closet_transfer', {
            p_snapshot: snapshot, p_reserve: reserve, p_review_meat: review.meat, p_review_items: review.items,
        });
        if (!operation) return;
        const label = `${operation.closet_reference} (UUID ${operation.id})`;
        const shortLabel = reference(operation, 'closet_reference');
        const source = ({donation:'donation',sale_fee:'auction commission',gift_package:'donated gift package'})[operation.source] || 'income';
        log(`[CLOSET ${shortLabel}] Moving ${source}: ${assets(operation.meat, operation.item_id ? [{id:operation.item_id,quantity:operation.quantity}] : [])}${operation.receipt_id ? ` · KMail ${operation.receipt_id}` : ''}.`);
        if (process.env.BOT_LOG_DETAILS === 'true') log(`[DETAIL ${shortLabel}] Closet UUID ${operation.id}${operation.auction_id ? `; auction UUID ${operation.auction_id}` : ''}.`);
        let evidence;
        try { evidence = await transport.depositCloset(operation); }
        catch (error) {
            const detail = error instanceof ClosetTransferError ? JSON.stringify(error.diagnostic) : 'No safe request/balance diagnostic available.';
            log(`[REVIEW ${shortLabel}] Closet transfer unconfirmed${error instanceof ClosetTransferError && error.diagnostic.stage === 'balance_mismatch' ? ': observed balances did not match the expected transfer' : ''}. No automatic retry; review required.`);
            log(`[DETAIL ${shortLabel}] Closet UUID ${operation.id}; diagnostic: ${detail}`);
            operatorLogs?.failureForReceipt(operation.receipt_id, `Closet transfer ${shortLabel} unconfirmed`);
            try {
                await store.rpc('bot_ack_closet_transfer', { p_id: operation.id, p_attempt: operation.attempt,
                    p_moved: false, p_evidence: `Closet outcome uncertain. ${detail} Compare recorded and actual balances before resolving; never automatically retry.` });
            } catch { /* The durable row remains moving and blocks future transfers. */ }
            throw new Error(`Closet transfer ${label} requires reconciliation; no automatic retry.`);
        }
        try {
            await store.rpc('bot_ack_closet_transfer', { p_id: operation.id, p_attempt: operation.attempt, p_moved: true, p_evidence: evidence });
        } catch {
            operatorLogs?.failureForReceipt(operation.receipt_id, `Closet transfer ${shortLabel}: database acknowledgment failed`);
            throw new Error(`Closet transfer ${label}: database acknowledgment failed; inspect balances before retrying.`);
        }
        log(`[CLOSET ${shortLabel}] Transfer verified · ${source}.`);
        await pause();
        snapshot = await transport.closetSnapshot();
    }
}
