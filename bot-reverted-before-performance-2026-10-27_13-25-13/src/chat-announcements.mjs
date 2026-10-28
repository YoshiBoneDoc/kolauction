import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_MESSAGES } from './chat-messages.mjs';

export const CHAT_INTERVAL = 6 * 60 * 60 * 1000;
export const chatStatePath = fileURLToPath(new URL('../data/chat-announcements.json', import.meta.url));
export function readChatState(path) {
    try { const value = JSON.parse(readFileSync(path, 'utf8'));if (value === null) throw Error('Invalid chat schedule');return value; }
    catch (error) { if (error.code === 'ENOENT') return null;throw error; }
}
export function saveChatState(value, path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
}

// Runs at a completed auction-cycle boundary, using the SAME logged-in client.
// No chat/mail poller or separate login. Persist the cooldown BEFORE any request,
// including channel entry, so interruption cannot cause a restart posting burst.
export function createChatAnnouncer({ transport, enabled = true, channel = 'trade', messages = CHAT_MESSAGES,
    signal, log = console.log, now = Date.now, path = chatStatePath, read = readChatState, save = saveChatState } = {}) {
    channel = String(channel).replace(/^\//, '');
    const valid = /^[a-z][a-z0-9_-]{0,29}$/.test(channel) && Array.isArray(messages) && messages.length > 0 && messages.every(message =>
        typeof message === 'string' && message.trim() === message && message.length > 0
        && !/[\r\n]/.test(message) && !message.startsWith('/') && !message.includes('&&') && [...`/${channel} ${message}`].length <= 255);
    if (enabled && !valid) log('Chat announcements disabled: check the channel and message list. Auction processing continues.');
    let running = false;
    let nextCheck = 0;
    return {
        async tick() {
            if (!enabled || !valid || running || signal?.aborted || now() < nextCheck || transport.transfersAllowed?.() === false) return;
            running = true;
            let state;
            try {
                state = read(path);
                if (state !== null && (state.version !== 1 || !Number.isSafeInteger(state.nextAt) || state.nextAt < 0
                    || !Number.isSafeInteger(state.nextIndex) || state.nextIndex < 0
                    || state.intervalMs != null && (!Number.isSafeInteger(state.intervalMs) || state.intervalMs <= 0))) throw Error('Invalid chat schedule');
                // Older bundles saved four-hour slots without an interval field.
                // Rebase the saved deadline when policy changes, keeping the
                // original send-time anchor and next message in the rotation.
                if (state && (state.intervalMs ?? 4 * 60 * 60 * 1000) !== CHAT_INTERVAL) {
                    state.nextAt = Math.max(0, state.nextAt - (state.intervalMs ?? 4 * 60 * 60 * 1000) + CHAT_INTERVAL);
                    state.intervalMs = CHAT_INTERVAL;
                    save(state, path);
                }
                if (state && now() < state.nextAt) { nextCheck = state.nextAt;return; }
                if (signal?.aborted) return;
                const index = (state?.nextIndex || 0) % messages.length;
                state = { version: 1, intervalMs: CHAT_INTERVAL, nextAt: now() + CHAT_INTERVAL, nextIndex: (index + 1) % messages.length,
                    attemptedAt: new Date(now()).toISOString(), channel, messageIndex: index, outcome: 'reserved' };
                save(state, path);
                nextCheck = state.nextAt;
                if (signal?.aborted) return;
                let outcome;
                try {
                    outcome = await transport.postChatAnnouncement(channel, messages[index], { shouldStop: () => signal?.aborted === true });
                } catch { outcome = 'unconfirmed'; }
                // A timeout or missing echo may still mean the post happened.
                // Never retry during this six-hour window, including after restart.
                state.nextAt = Math.max(state.nextAt, now() + CHAT_INTERVAL);
                state.outcome = outcome === 'confirmed' ? 'confirmed' : 'unconfirmed';
                save(state, path);
                nextCheck = state.nextAt;
                log(state.outcome === 'confirmed'
                    ? `Chat announcement ${index + 1} confirmed in /${channel}; next announcement in six hours.`
                    : 'Chat announcement was not confirmed; no immediate retry. Auction processing continues.');
            } catch {
                // No raw filesystem/session errors: paths/requests can contain secrets.
                // Never send unless the preceding cooldown reservation was saved.
                nextCheck = Math.max(nextCheck, now() + 300000);
                log('Chat schedule could not be read or saved; announcements deferred. Auction processing continues.');
            } finally { running = false; }
        },
    };
}
