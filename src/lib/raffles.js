import { parseMeatAmount } from './auctionInputs.js';

export const ODDS_TOTAL = 10000;
export function equalOdds(prizes) {
    if (!prizes.length) return [];
    const base = Math.floor(ODDS_TOTAL / prizes.length);
    return prizes.map((p, index) => ({ ...p, locked: false, chance: String((base + (index < ODDS_TOTAL % prizes.length ? 1 : 0)) / 100) }));
}
export function chanceUnits(value) {
    const text = String(value).trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    const units = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(units) && units >= 0 && units <= ODDS_TOTAL ? units : null;
}
export function prizeOddsTotal(prizes) {
    const units = prizes.map(p => chanceUnits(p.chance));
    return units.some(v => v === null) ? null : units.reduce((a, b) => a + b, 0);
}
// Integer largest-remainder allocation preserves an exact 100% without drift.
function allocateOdds(prizes, fixedIds) {
    const fixed = prizes.filter(p => fixedIds.has(p.id));
    const available = ODDS_TOTAL - fixed.reduce((sum, p) => sum + chanceUnits(p.chance), 0);
    const open = prizes.filter(p => !fixedIds.has(p.id));
    if (available < 0 || (!open.length && available !== 0)) throw new Error('Cannot balance these odds. Unlock another prize or reduce the percentage.');
    const weights = open.map(p => chanceUnits(p.chance));
    const weightTotal = weights.reduce((sum, w) => sum + w, 0);
    const denominator = weightTotal || open.length;
    const shares = open.map((p, i) => {
        const numerator = available * (weightTotal ? weights[i] : 1);
        return { id: p.id, units: Math.floor(numerator / denominator), remainder: numerator % denominator, index: i };
    });
    const remainder = available - shares.reduce((sum, p) => sum + p.units, 0);
    [...shares].sort((a, b) => b.remainder - a.remainder || a.index - b.index).slice(0, remainder).forEach(p => { p.units++; });
    const amounts = new Map(shares.map(p => [p.id, String(p.units / 100)]));
    return prizes.map(p => fixedIds.has(p.id) ? p : { ...p, chance: amounts.get(p.id) });
}
export function adjustPrizeOdds(prizes, id, value) {
    const edited = prizes.find(p => p.id === id);
    if (!edited || edited.locked) throw new Error('Unlock this prize before editing its odds.');
    if (chanceUnits(value) === null) throw new Error('Enter a percentage from 0 to 100 with up to two decimal places.');
    return allocateOdds(prizes.map(p => p.id === id ? { ...p, chance: value } : p), new Set(prizes.filter(p => p.locked || p.id === id).map(p => p.id)));
}
export function nudgePrizeOdds(prizes, id, direction) {
    const edited = prizes.find(p => p.id === id);
    if (!edited || edited.locked) throw new Error('Unlock this prize before editing its odds.');
    const current = chanceUnits(edited.chance);
    const others = prizes.filter(p => p.id !== id);
    if (!others.some(p => !p.locked)) return prizes;
    const available = ODDS_TOTAL - others.filter(p => p.locked).reduce((sum, p) => sum + chanceUnits(p.chance), 0);
    const step = Math.round(400 / prizes.length);
    const next = Math.max(0, Math.min(available, current + direction * step));
    return adjustPrizeOdds(prizes, id, String(next / 100));
}
export function rebalancePrizePool(previous, next) {
    if (!next.length) return [];
    const unlocked = previous.filter(p => !p.locked);
    const average = unlocked.length ? Math.round(unlocked.reduce((sum, p) => sum + chanceUnits(p.chance), 0) / unlocked.length) : 0;
    const existing = new Set(previous.map(p => p.id));
    return allocateOdds(next.map(p => existing.has(p.id) ? p : { ...p, locked: false, chance: String(average / 100) }), new Set(next.filter(p => p.locked).map(p => p.id)));
}
export function validateRaffle({ name, ticketPrice, endsAt, prizes }, now = Date.now()) {
    if (!name.trim() || name.trim().length > 80) throw new Error('Enter a raffle name (1–80 characters).');
    const parsedPrice = parseMeatAmount(ticketPrice, 1e12);
    if (parsedPrice === null) throw new Error('Enter a whole-Meat ticket price between 1 and 1 trillion.');
    const end = new Date(endsAt).getTime();
    if (!Number.isFinite(end) || end <= now || end > now + 365 * 86400000) throw new Error('Choose a closing time within the next 365 days.');
    if (!prizes.length || prizes.length > 20 || new Set(prizes.map(p => p.id)).size !== prizes.length) throw new Error('Choose 1–20 different prize items.');
    if (prizes.some(p => !Number.isSafeInteger(p.id) || p.id < 1 || !Number.isSafeInteger(Number(p.quantity)) || Number(p.quantity) < 1 || Number(p.quantity) > 1e9)) throw new Error('Enter whole prize quantities between 1 and 1 billion.');
    if (prizeOddsTotal(prizes) !== ODDS_TOTAL) throw new Error('Win chances must total exactly 100% (up to 2 decimal places).');
    return { name: name.trim(), ticketPrice: parsedPrice, endsAt: new Date(end).toISOString(), prizes: prizes.map(p => ({ id: p.id, quantity: Number(p.quantity), probability_bps: chanceUnits(p.chance) })) };
}
export function raffleCountdown(endsAt, now) {
    const seconds = Math.max(0, Math.ceil((new Date(endsAt).getTime() - now) / 1000));
    if (!seconds) return 'Closed · participation unavailable';
    return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds / 3600) % 24}h ${Math.floor(seconds / 60) % 60}m remaining`;
}

// Raffles have no ordinary auction status, buyout, bundle or ownership projection.
export function matchesRaffleBrowse(raffle, { query = '', status = 'active', kind = 'all', trade = 'all', buyout = 'any', bundle = 'any', ownershipFiltered = false, minPrice = null, maxPrice = null } = {}) {
    if (!['active', 'all'].includes(status) || kind === 'buy' || !['all', 'escrow'].includes(trade)
        || buyout === 'with' || bundle === 'with' || ownershipFiltered) return false;
    const price = Number(raffle.ticket_price);
    if ((minPrice !== null && price < minPrice) || (maxPrice !== null && price > maxPrice)) return false;
    const search = query.trim().toLowerCase();
    return !search || [raffle.name, ...(raffle.prizes || []).map(p => p.name)].some(name => name.toLowerCase().includes(search));
}
