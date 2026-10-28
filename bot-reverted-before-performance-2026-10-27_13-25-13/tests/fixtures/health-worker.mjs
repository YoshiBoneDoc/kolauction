// Deliberately has no KoL client, Supabase client, credentials, or network access.
import { readFileSync, writeFileSync } from 'node:fs';
import { EscrowWorker } from '../../src/worker.mjs';

const [mode, path] = process.argv.slice(2);
if (mode === 'duplicate') process.exit(78);
const send = value => { if (process.connected) process.send(value, () => {}); };
send({ type: 'ready', state: 'starting' });
if (mode === 'crash') process.exit(1);
if (mode === 'hang') {
    process.on('SIGTERM', () => {});
    while (true) {} // Test the parent, even when the child's event loop is frozen.
}
if (mode === 'uncertain') {
    const ledger = JSON.parse(readFileSync(path, 'utf8'));
    if (!ledger.state) {
        writeFileSync(path, JSON.stringify({ state: 'sending', sends: 1, pid: process.pid }));
        process.on('SIGTERM', () => {});
        setInterval(() => send({ type: 'heartbeat' }), 20);
    } else {
        try { process.kill(ledger.pid, 0); throw new Error('Workers overlapped'); }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
        const worker = new EscrowWorker({ live: true, log: () => {}, store: { async rpc(name) {
            if (name === 'bot_inspect') return { attention: [{ id: 'pending-send' }], closetAttention: [] };
            if (name === 'bot_claim_review_notice') return null;
            throw new Error('Blocked ledger must not claim another transfer');
        } }, transport: { async send() { throw new Error('Must never resend'); } } });
        setInterval(async () => send({ type: 'cycle', ...(await worker.cycle()) }), 20);
        process.on('SIGTERM', () => process.exit(0));
    }
} else {
    const state = ['blocked', 'maintenance', 'rollover'].includes(mode) ? mode : 'healthy';
    setInterval(() => send({ type: 'cycle', state, ...(state === 'rollover'
        ? { rollover_at: Date.now() - 3600000, maintenance: false } : {}) }), 20);
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), mode === 'delayed-stop' ? 80 : 0));
}
process.on('disconnect', () => process.exit(0));
