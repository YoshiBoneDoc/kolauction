import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';
import { assertNoPrivateCredentials, assertPublicEnvironment, assertPublicAssets, assetSecurityPlugin } from '../scripts/assetSecurity.mjs';
import { checkGitSecrets } from '../scripts/checkSecrets.mjs';

const privateKey = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + 'synthetic-test-data-only';
const secret = 'sb_secret_' + 's'.repeat(32);
const token = role => [Buffer.from('{"alg":"HS256"}').toString('base64url'), Buffer.from(JSON.stringify({role})).toString('base64url'), 's'.repeat(43)].join('.');

test('private credentials are rejected without including their values in errors; public Supabase keys remain allowed',()=>{
    for (const value of [privateKey, secret, token('service_role'), token('supabase_admin')]) {
        assert.throws(()=>assertNoPrivateCredentials(value,'assets/app.js'),error=>{
            assert.match(error.message,/Publication blocked/);
            assert.match(error.message,/assets\/app.js/);
            assert.ok(!error.message.includes(value));return true;
        });
    }
    for (const value of ['sb_publishable_'+'p'.repeat(32),token('anon'),'Ordinary auction text']) {
        assert.doesNotThrow(()=>assertNoPrivateCredentials(value,'app.js'));
    }
});

test('VITE environment variables cannot contain privileged keys, private keys, or password variables',()=>{
    for (const environment of [{VITE_SUPABASE_PUBLISHABLE_KEY:secret},{VITE_SUPABASE_PUBLISHABLE_KEY:token('service_role')},
        {VITE_UNRELATED_NAME:privateKey},{VITE_KOL_PASSWORD:'an ordinary password'},{VITE_SERVICE_ROLE_KEY:'another value'}]) {
        assert.throws(()=>assertPublicEnvironment(environment),/Publication blocked/);
    }
    assert.doesNotThrow(()=>assertPublicEnvironment({VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'p'.repeat(32),
        VITE_SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:secret}));
});

test('public asset scanner rejects private filenames, backups, nested credentials and symlinks',async()=>{
    const root=await mkdtemp(join(tmpdir(),'khub-asset-guard-'));
    try {
        await writeFile(join(root,'ordinary.js'),'console.log("public asset");');
        await assertPublicAssets(root);
        for (const path of ['.env','.env.production','ssh.key','archive.tar.gz','backup.sql','keys/innocent.txt','bot/source.js','.git/config']) {
            const full=join(root,path);await mkdir(resolve(full,'..'),{recursive:true});await writeFile(full,'synthetic data');
            await assert.rejects(assertPublicAssets(root),/Publication blocked/);
            await rm(join(root,path.split('/')[0]),{recursive:true,force:true});
        }
        await writeFile(join(root,'app.js'),`const unexpected = ${JSON.stringify(secret)};`);
        await assert.rejects(assertPublicAssets(root),/Supabase secret key/);await rm(join(root,'app.js'));
        await symlink(join(root,'ordinary.js'),join(root,'linked.js'));
        await assert.rejects(assertPublicAssets(root),/unsafe asset path/);
    } finally {await rm(root,{recursive:true,force:true});}
});

test('Vite build blocks copied public secrets and secrets bundled from source, including absolute output paths',async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'khub-build-guard-')));
    try {
        await mkdir(join(root,'public'));await writeFile(join(root,'index.html'),'<script type="module" src="/main.js"></script>');
        await writeFile(join(root,'main.js'),'console.log("clean build");');
        const options={root,configFile:false,logLevel:'silent',plugins:[assetSecurityPlugin()],build:{outDir:join(root,'output')}};
        await build(options);
        await writeFile(join(root,'public','.env'),'synthetic value');
        await assert.rejects(build(options),/Private or unsafe asset path/);await rm(join(root,'public','.env'));
        await writeFile(join(root,'main.js'),`console.log(${JSON.stringify(secret)});`);
        await assert.rejects(build(options),error=>{
            assert.match(error.message,/Supabase secret key/);assert.ok(!error.message.includes(secret));return true;
        });
    } finally {await rm(root,{recursive:true,force:true});}
});

test('commit guard inspects staged blobs rather than only the cleaned working copy and blocks forced private files',async()=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'khub-git-guard-')));
    const git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
    try {
        git(['init','--quiet']);
        await writeFile(join(root,'main.js'),JSON.stringify(secret));git(['add','main.js']);
        await writeFile(join(root,'main.js'),'Clean working copy');
        await assert.rejects(checkGitSecrets({directory:root,staged:true}),/Supabase secret key/);
        assert.equal(await checkGitSecrets({directory:root}),1);
        git(['add','main.js']);assert.equal(await checkGitSecrets({directory:root,staged:true}),1);
        await writeFile(join(root,'.env'),'Even credential-free environment files stay private');git(['add','--force','.env']);
        await assert.rejects(checkGitSecrets({directory:root,staged:true}),/Private file .env/);
    } finally {await rm(root,{recursive:true,force:true});}
});
