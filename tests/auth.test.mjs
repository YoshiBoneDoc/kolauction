import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from '../src/lib/auth.js';

const build = client => createAuthService(client, { origin: 'https://auction.example' });

test('website registration cannot call public email signup', async () => {
    const auth = build({ auth: { signUp() { assert.fail('email signup must not be called'); } } });
    await assert.rejects(auth.register({ email: 'someone@example.com', password: 'password' }), /Register through kHub KMail/);
});

test('username login resolves only the internal identity and preserves the password', async () => {
    const auth = build({ async rpc(name, args) {
        assert.equal(name, 'khub_login_address'); assert.deepEqual(args, { p_username: 'KH_Player' });
        return { data: 'account-id@login.khub.invalid' };
    }, auth: { async signInWithPassword(input) {
        assert.deepEqual(input, { email: 'account-id@login.khub.invalid', password: 'private password' });
        return { data: { session: 'session' } };
    } } });
    assert.deepEqual(await auth.login(' KH_Player ', 'private password'), { session: 'session' });
});

test('unprefixed names fail before Auth; prefixed KoL names containing @ use username lookup', async () => {
    const calls = [];
    const auth = build({ async rpc(name, args) { calls.push(args.p_username); return { data: 'account-id@login.khub.invalid' }; },
        auth: { async signInWithPassword(input) { return { data: input }; } } });
    await assert.rejects(auth.login('Player', 'secret'), /KH_/);
    assert.deepEqual(calls, []);
    await auth.login('kh_Player@example', 'secret');
    assert.deepEqual(calls, ['kh_Player@example']);
});

test('legacy email login remains available without username lookup', async () => {
    const failure = new Error('Invalid login credentials');
    const auth = build({ rpc() { assert.fail('do not look up a personal email'); }, auth: { async signInWithPassword(input) {
        assert.deepEqual(input, { email: 'seller@example.com', password: 'wrong password' });
        return { error: failure };
    } } });
    await assert.rejects(auth.login(' Seller@Example.COM ', 'wrong password'), failure);
});

test('missing username and unavailable lookup never attempt a login', async () => {
    for (const response of [{ data: null }, { error: new Error('missing migration') }]) {
        const auth = build({ rpc: async () => response, auth: { signInWithPassword() { assert.fail('lookup failed'); } } });
        await assert.rejects(auth.login('KH_Unknown', 'secret'), /Invalid username|temporarily unavailable/);
    }
    await assert.rejects(build(null).login('Player', 'secret'), /not configured/);
});

function profileClient(profile) {
    return { from(table) { assert.equal(table, 'profiles'); return { select(columns) {
        assert.equal(columns, 'id, khub_username, is_banned, account_method');
        return { eq(column, id) { assert.equal(column, 'id'); assert.equal(id, 'user-1');
            return { single: async () => ({ data: profile }) }; } };
    } }; } };
}

test('bot-created profiles hide internal email and load the server-owned username', async () => {
    const auth = build(profileClient({ id: 'user-1', khub_username: 'Player', account_method: 'kmail', is_banned: false }));
    assert.deepEqual(await auth.loadProfile({ id: 'user-1', email: 'private@login.khub.invalid' }), {
        id: 'user-1', khubUsername: 'Player', accountMethod: 'kmail', email: null,
    });
});

test('missing and banned profiles fail closed', async () => {
    await assert.rejects(build(profileClient(null)).loadProfile({ id: 'user-1' }), /could not be loaded/);
    await assert.rejects(build(profileClient({ id: 'user-1', is_banned: true })).loadProfile({ id: 'user-1' }), /restricted/);
});

test('password changes enforce length and preserve server failures', async () => {
    let updates = 0;
    const auth = build({ auth: { async updateUser(input) {
        updates++; assert.deepEqual(input, { password: 'a unique new password' });
        return { error: new Error('Server rejected password change') };
    } } });
    await assert.rejects(auth.updatePassword('short'), /at least 12/);
    assert.equal(updates, 0);
    await assert.rejects(auth.updatePassword('a unique new password'), /Server rejected/);
    assert.equal(updates, 1);
});

test('appeal sign-in uses the separate resolver without changing normal login',async()=>{
    const names=[];
    const auth=build({async rpc(name){names.push(name);return {data:'account-id@login.khub.invalid'};},auth:{async signInWithPassword(input){return {data:input};}}});
    await auth.login('KH_Player','same password',{appeal:true});
    await auth.login('KH_Player','same password');
    assert.deepEqual(names,['khub_appeal_login_address','khub_login_address']);
});
