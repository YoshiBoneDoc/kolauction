import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { UserContext } from '../context/UserContext';
import { escrowPromotion } from '../lib/escrowPromotionService';

// All rate selection and arithmetic come from PostgreSQL. Stale/missing quotes
// never fall back to an independently calculated browser fee.
export default function useEscrowFeePreview(price, active = true, { kind = 'sell', quantity = 1, auctionId = null } = {}) {
    const { currentUser } = useContext(UserContext) ?? {};
    const scope = currentUser?.id ?? null;
    const snapshot = useSyncExternalStore(escrowPromotion.subscribe, escrowPromotion.getSnapshot, escrowPromotion.getSnapshot);
    const [result, setResult] = useState(null);
    useEffect(() => { if (active) return escrowPromotion.activate(scope); }, [scope, active]);
    useEffect(() => { if (active) escrowPromotion.refresh(); }, [price, kind, quantity, active]);
    const metadata = active && snapshot.scope === scope ? snapshot.data : null;
    const key = JSON.stringify([scope, price, quantity, kind, auctionId]);
    useEffect(() => {
        if (!active || !Number.isSafeInteger(price) || price < 0 || !Number.isSafeInteger(quantity) || quantity < 1 || !metadata) return;
        if (price === 0 && kind === 'sell' && !auctionId) return;
        let cancelled = false;
        const timer = setTimeout(() => {
            escrowPromotion.quote({ price, quantity, kind, auctionId }).then(data => {
                if (!cancelled) setResult({ key, data, metadata });
            }).catch(() => { if (!cancelled) setResult({ key, data: null, metadata }); });
        }, 250);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [active, price, quantity, kind, auctionId, key, metadata]);
    const data = price === 0 && kind === 'sell' && !auctionId ? metadata : result?.key === key && result.metadata === metadata ? result.data : null;
    return { fee: data?.fee == null ? null : Number(data.fee), originalFee: data?.normal_fee == null ? null : Number(data.normal_fee),
        enabled: metadata?.enabled, volume: metadata?.volume, promotion: metadata?.promotion,
        engineEnabled: metadata?.engine_enabled, quote: data, metadata };
}
