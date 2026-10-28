import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const tools=fileURLToPath(new URL('../tools/',import.meta.url));
const source=await readFile(join(tools,'bundle.mjs'),'utf8');
const files=[...source.match(/const files = \[([\s\S]*?)\n\];/)[1].matchAll(/'([^']+)'/g)].map(m=>m[1]);

test('bot packaging blocks pasted private credentials, configured passwords, private files and symlinks before creating an archive',async()=>{
 const root=await mkdtemp(join(tmpdir(),'khub-bundle-security-'));
 try {
  for(const file of files) {
   const path=join(root,file);
   if(['src','catalog','supabase','tools'].includes(file))await mkdir(path,{recursive:true});
   else {await mkdir(dirname(path),{recursive:true});await writeFile(path,'Safe synthetic fixture');}
  }
  await copyFile(join(tools,'bundle.mjs'),join(root,'tools/bundle.mjs'));
  await copyFile(join(tools,'assetSecurity.mjs'),join(root,'tools/assetSecurity.mjs'));
  const password='synthetic-password-not-a-real-credential';
  await writeFile(join(root,'.env'),`KOL_PASSWORD=${password}\n`,{mode:0o600});
  const run=()=>spawnSync(process.execPath,['tools/bundle.mjs'],{cwd:root,encoding:'utf8'});
  let result=run();assert.equal(result.status,0,result.stderr);
  const listing=spawnSync('tar',['-tzf',join(root,'exports/khub-bot.tar.gz')],{encoding:'utf8'});
  assert.equal(listing.status,0);assert.ok(!listing.stdout.split('\n').some(p=>p==='.env'||p.startsWith('keys/')));
  for(const value of ['-----BEGIN '+'OPENSSH PRIVATE KEY-----','sb_secret_'+'s'.repeat(32),password]) {
   await writeFile(join(root,'src/leak.mjs'),JSON.stringify(value));
   result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/blocked/i);assert.ok(!result.stderr.includes(value));
   await rm(join(root,'src/leak.mjs'));
  }
  await writeFile(join(root,'src/private.key'),'Not a real key');result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/unsafe bundle path/);await rm(join(root,'src/private.key'));
  await writeFile(join(root,'ordinary.txt'),'Safe fixture');await symlink(join(root,'ordinary.txt'),join(root,'src/link'));
  result=run();assert.notEqual(result.status,0);assert.match(result.stderr,/unsafe bundle path/);
 }finally{await rm(root,{recursive:true,force:true});}
});
