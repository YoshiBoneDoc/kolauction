const PREFIX = 'khub-public-auctions:v1:';
const REVISION = /^(0|[1-9][0-9]{0,18})$/;

export function validRevision(value) {
    return typeof value === 'string' && REVISION.test(value) && BigInt(value) <= 9223372036854775807n;
}

export async function verifyInvalidation(payload, secret) {
    if (!payload || !validRevision(payload.revision) || typeof payload.signature !== 'string'
        || !/^[a-f0-9]{64}$/.test(payload.signature) || typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)
        || Object.keys(payload).some(key => !['revision', 'signature'].includes(key))) return false;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signature = Uint8Array.from(payload.signature.match(/../g), part => Number.parseInt(part, 16));
    return crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(PREFIX + payload.revision));
}

// Bound actual streamed bytes, not just an attacker-controlled Content-Length.
export async function readInvalidation(request) {
    if (!request.body) throw new Error('Missing notification.');
    const reader = request.body.getReader();
    const chunks = []; let length = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > 512) throw new Error('Notification too large.');
            chunks.push(value);
        }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const buffer = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(buffer));
}
