import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const healthPath = fileURLToPath(new URL('../data/health.json', import.meta.url));
export const states = new Set(['starting', 'working', 'healthy', 'read-only', 'rollover', 'maintenance', 'blocked', 'error', 'restarting', 'stopping', 'stopped']);

export function saveHealth(value, path = healthPath) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, path);
}

export function readHealth(path = healthPath, now = Date.now()) {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8'));
        if (value.state === 'stopped') return value;
        const age = now - Date.parse(value.updated_at);
        if (!Number.isFinite(age) || age < -60000 || age > 90000) return { ...value, state: 'stale' };
        try { process.kill(value.supervisor_pid, 0); }
        catch { return { ...value, state: 'stale' }; }
        return value;
    } catch { return { state: 'unavailable' }; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const value = readHealth();
    if (!process.argv.includes('--check')) console.log(JSON.stringify(value, null, 2));
    process.exitCode = ['healthy', 'read-only', 'rollover', 'maintenance', 'working', 'starting'].includes(value.state) ? 0 : 1;
}
