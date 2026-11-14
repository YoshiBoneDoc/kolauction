// Browser-only teaching fixtures. Values are illustrative, never live quotes.
export const demoItems = [
    { id: 194, name: 'Mr. Accessory', image: 'mracc.gif', tradeable: true, demoPrice: 50_000_000 },
    { id: 258, name: 'dense meat stack', image: 'meatstack.gif', tradeable: true, demoPrice: 1_000_000 },
    { id: 10881, name: '11-leaf clover', image: '11leafclover.gif', tradeable: true, demoPrice: 500_000 },
    { id: 9564, name: 'mafia thumb ring', image: 'mafiaring5.gif', tradeable: true, demoPrice: 3_000_000 },
    { id: 938, name: 'tiny plastic sword', image: 'plasword.gif', tradeable: true, demoPrice: 1_000_000 },
];
export const demoImage = image => `https://images.kingdomofloathing.com/itemimages/${image}`;
export const demoListings = {
    host: { item: 'Grimacite gown', image: demoImage('g2gown.gif'), quantity: 1 },
    bidder: { item: 'Mr. Accessory', image: demoImage('mracc.gif'), quantity: 1 },
};
export function demoPrices(now = Date.now()) {
    const stamp = new Date(now).toISOString();
    return new Map(demoItems.map(item => [item.id, { available: true, price_meat: item.demoPrice, checked_at: stamp, observed_at: stamp }]));
}
const item = (id, quantity) => {
    const source = demoItems.find(row => row.id === id);
    return { id, name: source.name, quantity, image: demoImage(source.image) };
};
const total = (meat, items) => meat + items.reduce((sum, row) => sum + demoItems.find(source => source.id === row.id).demoPrice * row.quantity, 0);
function offer(id, bidderLabel, meat, items, status = 'pending') {
    return { id, bidderLabel, meat, items, value: total(meat, items), status, rejectedItems: [], raiseRequested: false, acceptedOrder: 0 };
}
export function createBarterDemo(role, scenario = 'changes_requested') {
    const leader = offer('demo-leading', 'Bidder 1', 5_000_000, [item(194, 1), item(258, 10), item(9564, 1), item(938, 2)], 'accepted');
    const own = offer('demo-own', 'You', 5_000_000, [item(194, 1), item(10881, 2), item(258, 2), item(9564, 1), item(938, 1)], scenario === 'superseded' ? 'accepted' : scenario);
    if (scenario === 'changes_requested') { own.rejectedItems = [10881]; own.raiseRequested = true; }
    own.acceptedOrder = 1;
    if (scenario === 'superseded') leader.acceptedOrder = 2;
    return {
        role, scenario, ended: false, sequence: scenario === 'superseded' ? 3 : 2, formVersion: 0, draftOffer: null, notice: '',
        currentOfferId: role === 'bidder' && scenario === 'accepted' ? own.id : leader.id,
        offers: role === 'host' ? [leader,
            offer('demo-items', 'Bidder 2', 0, [item(194, 1), item(10881, 8), item(258, 2), item(9564, 1), item(938, 1)]),
            offer('demo-mixed', 'Bidder 3', 2_500_000, [item(194, 1), item(10881, 1), item(258, 1), item(938, 1)]),
            offer('demo-meat', 'Bidder 4', 40_000_000, []),
        ] : [leader, own],
    };
}
export function latestDemoOffer(state) {
    return state.offers.filter(row => row.bidderLabel === 'You').at(-1);
}
export function barterDemoReducer(state, action) {
    if (action.type === 'reset' || action.type === 'scenario') {
        return { ...createBarterDemo(state.role, action.scenario || 'changes_requested'), formVersion: state.formVersion + 1 };
    }
    if (state.ended) return state;
    if (action.type === 'end') return {
        ...state, ended: true, draftOffer: null,
        offers: state.offers.map(row => ['pending', 'changes_requested'].includes(row.status) ? { ...row, status: 'expired' } : row),
        notice: 'The demo auction has ended. Only the last host-accepted offer wins; unaccepted offers expire.',
    };
    if (action.type === 'revise') {
        const source = state.offers.find(row => row.id === action.offerId && row.status === 'changes_requested');
        return source ? { ...state, draftOffer: source, formVersion: state.formVersion + 1, notice: 'The original offer is copied into the form. Edit its items or Meat, then submit a new offer.' } : state;
    }
    if (action.type === 'submit') {
        if (state.role !== 'bidder' || state.offers.some(row => row.bidderLabel === 'You' && row.status === 'pending')) return state;
        const fresh = offer(`demo-own-${state.sequence}`, 'You', action.meat, action.items.map(row => ({ ...row, image: demoImage(demoItems.find(source => source.id === row.id).image) })));
        return { ...state, offers: [...state.offers, fresh], sequence: state.sequence + 1, draftOffer: null, formVersion: state.formVersion + 1, notice: 'Practice offer submitted. It is pending, so the leading bid has not changed. Choose a simulated host response below.' };
    }
    if (action.type === 'decision') {
        const source = state.offers.find(row => row.id === action.offerId);
        const allowed = action.decision === 'withdrawn' ? ['pending', 'changes_requested'] : ['pending'];
        if (!source || !allowed.includes(source.status) || !['accepted', 'rejected', 'changes_requested', 'withdrawn'].includes(action.decision)) return state;
        const accepted = action.decision === 'accepted';
        return { ...state, sequence: state.sequence + 1,
            offers: state.offers.map(row => row.id === source.id ? { ...row, status: action.decision, rejectedItems: action.rejectedItems || [], raiseRequested: Boolean(action.raiseRequested), acceptedOrder: accepted ? state.sequence : row.acceptedOrder } : row),
            currentOfferId: accepted ? source.id : state.currentOfferId,
            notice: accepted ? 'This exact offer is now the leading bid—even if its estimated value is lower than the previous one.'
                : action.decision === 'rejected' ? 'The offer was rejected. It does not change the leading bid; the bidder can submit another offer.'
                    : action.decision === 'withdrawn' ? 'The offer was withdrawn. The bidder can submit another offer.'
                        : 'Changes requested. The offer is not accepted; the bidder can revise its items or Meat and submit a new offer.',
        };
    }
    if (action.type === 'revised-response' && state.role === 'host') {
        const source = state.offers.find(row => row.id === action.offerId && row.status === 'changes_requested');
        if (!source || state.offers.some(row => row.bidderLabel === source.bidderLabel && row.status === 'pending')) return state;
        const items = source.items.filter(row => !source.rejectedItems.includes(row.id));
        const meat = source.raiseRequested ? Math.max(source.meat, source.value + 5_000_000 - total(0, items)) : source.meat || (items.length ? 0 : 5_000_000);
        const revised = offer(`demo-revised-${state.sequence}`, source.bidderLabel, meat, items);
        return { ...state, sequence: state.sequence + 1, offers: [...state.offers, revised], notice: 'A simulated bidder submitted a new offer with the marked items removed. Review the new pending offer; the original feedback is preserved.' };
    }
    if (action.type === 'replace' && state.role === 'bidder') {
        const own = latestDemoOffer(state);
        if (!own || own.status !== 'accepted' || state.currentOfferId !== own.id) return state;
        const replacement = offer(`demo-replacement-${state.sequence}`, 'Another bidder', 25_000_000, [], 'accepted');
        replacement.acceptedOrder = state.sequence;
        return { ...state, sequence: state.sequence + 1, offers: [...state.offers, replacement], currentOfferId: replacement.id, notice: 'The host accepted another offer. Your earlier acceptance stays in history, but the other offer now leads—even at a lower estimated value.' };
    }
    return state;
}
