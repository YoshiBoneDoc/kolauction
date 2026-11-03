import { useContext, useEffect, useSyncExternalStore } from 'react';
import { UserContext } from '../context/UserContext';
import { escrowFee } from '../lib/escrowFees';
import { escrowPromotion } from '../lib/escrowPromotionService';
import { promotionalPreviewFee } from '../lib/escrowPromotion';

export default function useEscrowFeePreview(price, active = true) {
    const { currentUser } = useContext(UserContext) ?? {};
    const scope = currentUser?.id ?? null;
    const snapshot = useSyncExternalStore(escrowPromotion.subscribe, escrowPromotion.getSnapshot, escrowPromotion.getSnapshot);
    useEffect(() => {
        if (active) return escrowPromotion.activate(scope);
    }, [scope, active]);
    // Price changes can refresh aged metadata, without a per-keystroke RPC.
    useEffect(() => { if (active) escrowPromotion.refresh(); }, [price, active]);
    const data = active && snapshot.scope === scope ? snapshot.data : null;
    const originalFee = Number.isSafeInteger(price) && price >= 0 ? escrowFee(price) : null;
    return { fee: !data ? null : data.enabled ? promotionalPreviewFee(price, data) : originalFee,
        enabled: data?.enabled, volume: data?.volume, originalFee };
}
