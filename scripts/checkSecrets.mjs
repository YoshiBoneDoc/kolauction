import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { assertNoPrivateCredentials } from './assetSecurity.mjs';

export async function checkGitSecrets({ directory = process.cwd(), staged = false } = {}) {
    const git = args => execFileSync('git', args, { cwd: directory, maxBuffer: 100 * 1024 * 1024, stdio: ['ignore','pipe','pipe'] });
    const names = git(staged ? ['diff','--cached','--name-only','--diff-filter=ACMR','-z'] : ['ls-files','--cached','--others','--exclude-standard','-z'])
        .toString('utf8').split('\0').filter(Boolean);
    let settings = {};
    try { settings = parseEnv(await readFile(resolve(directory,'bot/.env'),'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not read local credential settings; secret check blocked.'); }
    const configured = ['SUPABASE_SERVICE_ROLE_KEY','KOL_PASSWORD'].filter(name=>settings[name]?.length>=8);
    let checked = 0;
    for (const name of new Set(names)) {
        const parts = name.split('/');
        const leaf = parts.at(-1);
        if (parts.slice(0,-1).some(part=>/^(?:bot|keys|\.ssh|\.aws|backups?|khub-backup.*)$/i.test(part))
            || /^\.env(?:\..*)?$/.test(leaf) && leaf!=='.env.example'
            || /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$|\.(?:key|pem|p12|pfx|dump|sqlite3?|db|tar\.gz|tgz|zip)$/i.test(leaf)) {
            throw new Error(`Private file ${name} must not be published. Secret check blocked.`);
        }
        let content;
        try { content = staged ? git(['show',`:${name}`]) : await readFile(resolve(directory,name)); }
        catch (error) {
            if (!staged && error.code==='ENOENT') continue;
            throw new Error(`Could not inspect ${name}; secret check blocked.`);
        }
        assertNoPrivateCredentials(content,name);
        for (const key of configured) {
            if (content.includes(settings[key])) throw new Error(`Configured ${key} found in ${name}. Secret check blocked.`);
        }
        checked++;
    }
    return checked;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
    try {
        const count = await checkGitSecrets({ staged: process.argv.includes('--staged') });
        process.stdout.write(`Secret check passed (${count} files).\n`);
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
