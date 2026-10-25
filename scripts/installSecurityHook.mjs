import { execFileSync } from 'node:child_process';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve(execFileSync('git',['rev-parse','--git-path','hooks/pre-commit'],{encoding:'utf8'}).trim());
const hook = await readFile(new URL('../.githooks/pre-commit',import.meta.url));
let existing;
try { existing = await readFile(destination); } catch (error) { if(error.code!=='ENOENT')throw error; }
if(existing && !existing.equals(hook))throw new Error('An existing pre-commit hook was preserved. Integrate the secret check manually.');
await writeFile(destination,hook,{mode:0o755});await chmod(destination,0o755);
console.log('Installed the local staged-secret check. No commit or push was performed.');
