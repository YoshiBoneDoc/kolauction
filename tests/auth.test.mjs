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
    return { async rpc(name) { assert.equal(name, 'read_my_account_access'); return { data: profile && {
        server_now: new Date().toISOString(), ban_expires_at: null, ...profile,
    } }; } };
}

test('bot-created profiles hide internal email and load the server-owned access state', async () => {
    const auth = build(profileClient({ id: 'user-1', khub_username: 'Player', account_method: 'kmail', is_banned: false, kol_player_id: 3552305, kol_player_name: 'Player' }));
    const user = await auth.loadProfile({ id: 'user-1', email: 'private@login.khub.invalid' });
    assert.equal(user.id, 'user-1'); assert.equal(user.khubUsername, 'Player'); assert.equal(user.email, null);
    assert.equal(user.accountMethod, 'kmail'); assert.equal(user.isBanned, false); assert.equal(user.banExpiresAt, null);
    assert.equal(user.kolPlayerId, 3552305); assert.equal(user.kolPlayerName, 'Player');
    assert.ok(Number.isFinite(user.serverOffset));
});

test('missing, mismatched and malformed profiles fail closed', async () => {
    for (const profile of [null, { id: 'someone-else', is_banned: false }, { id: 'user-1' },
        { id: 'user-1', is_banned: true, ban_expires_at: 'invalid' }]) {
        await assert.rejects(build(profileClient(profile)).loadProfile({ id: 'user-1' }), /could not be loaded/);
    }
});

test('restricted profile loads enough information for a ban screen and expiry countdown', async () => {
    const user = await build(profileClient({ id: 'user-1', is_banned: true, ban_expires_at: '2027-01-02T00:00:00Z' })).loadProfile({ id: 'user-1' });
    assert.equal(user.isBanned, true); assert.equal(user.banExpiresAt, '2027-01-02T00:00:00Z');
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
