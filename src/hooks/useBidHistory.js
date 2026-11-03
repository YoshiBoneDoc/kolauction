import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { withReadDeadline } from '../lib/readDeadline';
import { startPrivateRefresh } from '../lib/privateRefresh';

const empty = { bids: [], loading: true, error: false, hasMore: false, cursor: null };
export default function useBidHistory(auction, client = supabase) {
    const [state, setState] = useState(empty);
    const actions = useRef({});
    useEffect(() => {
        let active = true, running = false, generation = 0, requested = false, token, revision = null, revisionAt = 0;
        const controller = new AbortController();
        let current = empty;
        const publish = next => { current = next; if (active) setState(next); };
        async function load(older = false) {
            if (!active || older && !current.cursor) return;
            if (running) { if (!older) requested = true; return; }
            running = true;
            const stamp = generation;
            publish({ ...current, loading: true });
            try {
                const result = await withReadDeadline(async signal => {
                    const query = client.rpc('read_auction_bid_history', { p_id: auction.id,
                        ...(older ? { p_before_amount: current.cursor.amount, p_before_id: current.cursor.id }
                            : revision && Date.now()-revisionAt < 300000 ? { p_known_revision: revision } : {}) });
                    return await query.abortSignal(signal);
                }, { signal: controller.signal });
                if (result.error) throw result.error;
                if (!active || stamp !== generation) return;
                const data = result.data;
                if (data?.privacy_version !== 1 || !Array.isArray(data.bids) || data.bids.length > 50
                    || data.bids.some(bid => bid.auction_id !== auction.id)) throw Object.assign(new Error('Invalid history'), { code: 'KHUB_PRIVACY' });
                if (data.visible !== true) { revision = null; publish({ ...empty, loading: false }); return; }
                if (!older && data.unchanged === true) { publish({ ...current, loading: false, error: false }); return; }
                if (!older) { revision = data.revision || null; revisionAt = Date.now(); }
                const mapped = data.bids.map(bid => ({ id: bid.id, bidder: bid.bidder_username, amount: Number(bid.amount),
                    timestamp: Date.parse(bid.created_at), giveawayWinner: bid.giveaway_winner === true,
                    adminDeliveryReferences: bid.admin_delivery_references || [] }));
                const overlap = mapped.some(bid => current.bids.some(old => old.id === bid.id));
                const keepCursor = !older && overlap && current.bids.length > 50;
                const byId = new Map([...current.bids, ...mapped].map(bid => [bid.id, bid]));
                publish({ bids: [...byId.values()].sort((a,b) => a.amount-b.amount || a.id.localeCompare(b.id)),
                    loading: false, error: false, hasMore: keepCursor ? current.hasMore : data.has_more === true, cursor: keepCursor ? current.cursor : data.next_cursor });
            } catch (error) {
                if (active && stamp === generation) {
                    const privateFailure = ['42501','PGRST301','PGRST302','PGRST303','KHUB_PRIVACY'].includes(error.code) || [401,403].includes(error.status);
                    publish({ ...(privateFailure ? empty : current), loading: false, error: true });
                }
                throw error;
            } finally {
                running = false;
                if (requested && active) { requested = false; setTimeout(() => safeLoad(false), 0); }
            }
        }
        const safeLoad = older => load(older).catch(() => {});
        actions.current = { loadOlder: () => safeLoad(true), refresh: () => safeLoad(false) };
        publish(empty);
        const clear = () => { revision = null; revisionAt = 0; generation++; publish(empty); requested = running; setTimeout(() => safeLoad(false), 0); };
        actions.current.reset = clear;
        const subscription = client.auth.onAuthStateChange((event, session) => {
            const next = session?.access_token || null;
            if (event === 'INITIAL_SESSION') { token = next; return; }
            if (token === next && event !== 'USER_UPDATED') return;
            token = next;
            clear();
        });
        window.addEventListener('khub:ignore-list-changed', clear);
        const stop = startPrivateRefresh({ refresh: () => load(false), interval: 60000, document, window });
        return () => { active = false; controller.abort(); stop(); subscription.data.subscription.unsubscribe(); window.removeEventListener('khub:ignore-list-changed', clear); };
    }, [auction.id, client]);
    const previous = useRef({ id: auction.id, count: auction.bidCount, status: auction.status, bid: auction.currentBid });
    useEffect(() => {
        const old = previous.current;
        previous.current = { id: auction.id, count: auction.bidCount, status: auction.status, bid: auction.currentBid };
        // The resource effect already schedules the initial read on mount/navigation.
        if (old.id !== auction.id || old.count === auction.bidCount && old.status === auction.status && old.bid === auction.currentBid) return;
        if (old.status !== auction.status || auction.bidCount < old.count) actions.current.reset?.();
        else actions.current.refresh?.();
    }, [auction.id, auction.bidCount, auction.status, auction.currentBid]);
    return { ...state, loadOlder: () => actions.current.loadOlder?.(), refresh: () => actions.current.refresh?.() };
}
