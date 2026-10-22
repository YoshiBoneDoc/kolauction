import { auctionNow } from './auctionClock.js';

export const MAX_AUCTION_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export function localDateTimeInput(timestamp) {
    const date = new Date(timestamp);
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function customAuctionEnd(value, now = auctionNow()) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!parts) throw new Error('Choose an ending date and time.');
    const [, year, month, day, hour, minute] = parts.map(Number);
    const date = new Date(year, month - 1, day, hour, minute);
    // Reject invalid dates and local times skipped by a daylight-saving change.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day
        || date.getHours() !== hour || date.getMinutes() !== minute) {
        throw new Error('Choose a valid ending date and time in your timezone.');
    }
    if (date.getTime() <= now) throw new Error('The ending time must be in the future.');
    if (date.getTime() > now + MAX_AUCTION_DURATION_MS) throw new Error('Choose an ending time within the next 30 days.');
    return date.toISOString();
}

export function formatAuctionEnd(value) {
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'long' });
}
