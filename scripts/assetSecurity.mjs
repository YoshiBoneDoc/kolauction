import { readFile, readdir } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join, resolve } from 'node:path';

const privateKey = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;
const secretKey = /\bsb_secret_[A-Za-z0-9_-]{12,}/;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{15,}\b/g;

// Report only a filename/variable name and credential type, never the value.
export function assertNoPrivateCredentials(content, label) {
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    let kind = privateKey.test(text) ? 'private key' : secretKey.test(text) ? 'Supabase secret key' : null;
    for (const match of text.matchAll(jwt)) {
        let claims;
        try { claims = JSON.parse(Buffer.from(match[0].split('.')[1], 'base64url').toString('utf8')); }
        catch { continue; }
        if (claims.role === 'service_role' || claims.role === 'supabase_admin') kind = 'privileged Supabase JWT';
    }
    if (kind) throw new Error(`Private credential detected in ${label} (${kind}). Publication blocked.`);
}

export function assertPublicEnvironment(environment) {
    for (const [name, value] of Object.entries(environment)) {
        if (!name.startsWith('VITE_') || !value) continue;
        if (/(?:SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE)/i.test(name)) {
            throw new Error(`Private environment variable ${name} uses the public VITE_ prefix. Publication blocked.`);
        }
        assertNoPrivateCredentials(value, name);
    }
}

const privateDirectory = /^(?:\.git|\.ssh|\.aws|bot|keys|backups?|exports|khub-backup.*)$/i;
const privateFilename = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:key|pem|p12|pfx|sql|dump|sqlite3?|db|tar\.gz|tgz|zip)$/i;

export async function assertPublicAssets(directory) {
    async function visit(folder, relative = '') {
        let entries;
        try { entries = await readdir(folder, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        for (const entry of entries) {
            const label = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isSymbolicLink() || entry.isDirectory() && privateDirectory.test(entry.name)
                || entry.isFile() && privateFilename.test(entry.name)) {
                throw new Error(`Private or unsafe asset path ${label}. Publication blocked.`);
            }
            const path = join(folder, entry.name);
            if (entry.isDirectory()) await visit(path, label);
            else if (entry.isFile()) assertNoPrivateCredentials(await readFile(path), label);
        }
    }
    await visit(directory);
}

// Scan both public/ before copying and the finished output (including JS chunks).
export function assetSecurityPlugin() {
    let config;
    return {
        name: 'khub-private-asset-guard',
        apply: 'build',
        configResolved(value) { config = value; },
        async buildStart() { if (config.publicDir) await assertPublicAssets(config.publicDir); },
        generateBundle(_options, bundle) {
            for (const asset of Object.values(bundle)) {
                const parts = asset.fileName.split('/');
                if (parts.slice(0, -1).some(part => privateDirectory.test(part)) || privateFilename.test(parts.at(-1))) {
                    throw new Error(`Private or unsafe asset path ${asset.fileName}. Publication blocked.`);
                }
                assertNoPrivateCredentials(asset.type === 'chunk' ? asset.code : asset.source, asset.fileName);
            }
        },
        async writeBundle() { await assertPublicAssets(resolve(config.root, config.build.outDir)); },
    };
}
