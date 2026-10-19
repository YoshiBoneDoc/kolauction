import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService as buildAuthService } from '../src/lib/auth.js';
const createAuthService = (client) => buildAuthService(client, { origin: 'https://auction.example' });

const available = async () => ({ data: { username_taken: false, email_taken: false }, error: null });

test('signup sends username metadata and keeps passwords out of profiles', async () => {
    let request;
    const auth = createAuthService({ rpc: available, auth: { signUp: async (input) => {
        request = input;
        return { data: { user: { id: 'user-1' }, session: null }, error: null };
    } } });
    const result = await auth.register({ khubUsername: ' Seller ', email: ' seller@example.com ', password: 'long password' });
    assert.equal(result.session, null);
    assert.deepEqual(request, {
        email: 'seller@example.com', password: 'long password',
        options: { data: { khub_username: 'Seller' }, emailRedirectTo: 'https://auction.example/auth/confirm' },
    });
});

test('signup supports immediate sessions when confirmation is disabled', async () => {
    const session = { user: { id: 'user-1' } };
    const auth = createAuthService({ rpc: available, auth: { signUp: async () => ({ data: { session }, error: null }) } });
    assert.equal((await auth.register({ khubUsername: 'Seller', email: 'seller@example.com', password: 'long password' })).session, session);
});

test('invalid usernames and short passwords never reach signup', async () => {
    const auth = createAuthService(null);
    for (const khubUsername of [' ', 'a'.repeat(17)]) {
        await assert.rejects(auth.register({ khubUsername, email: 'x@y.com', password: '123456' }), /username/);
    }
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'x@y.com', password: '123' }), /at least 6/);
});

test('database trigger failures produce an actionable signup error', async () => {
    const auth = createAuthService({ rpc: available, auth: { signUp: async () => ({ error: { code: 'unexpected_failure', message: 'Database error saving new user' } }) } });
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'x@y.com', password: '123456' }), /username may already be taken/);
});

test('email login propagates authentication failures', async () => {
    const failure = new Error('Email not confirmed');
    const auth = createAuthService({ rpc: available, auth: { signInWithPassword: async (input) => {
        assert.deepEqual(input, { email: 'seller@example.com', password: 'wrong password' });
        return { error: failure };
    } } });
    await assert.rejects(auth.login(' seller@example.com ', 'wrong password'), failure);
});

test('profile loads only the authenticated user and exposes no password', async () => {
    const client = { from(table) {
        assert.equal(table, 'profiles');
        return { select(columns) {
            assert.equal(columns, 'id, khub_username');
            return { eq(column, id) {
                assert.equal(column, 'id');
                assert.equal(id, 'user-1');
                return { single: async () => ({ data: { id, khub_username: 'Seller' }, error: null }) };
            } };
        } };
    } };
    assert.deepEqual(await createAuthService(client).loadProfile({ id: 'user-1', email: 'seller@example.com' }), {
        id: 'user-1', khubUsername: 'Seller', email: 'seller@example.com',
    });
});

test('missing profiles fail rather than using unverified username metadata', async () => {
    const auth = createAuthService({ from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: new Error('not found') }) }) }) }) });
    await assert.rejects(auth.loadProfile({ id: 'user-1', user_metadata: { khub_username: 'Admin' } }), /profile could not be loaded/);
});

test('unconfigured services fail with a readable message', async () => {
    await assert.rejects(createAuthService(null).login('seller@example.com', 'password'), /not configured/);
});


test('existing usernames, emails, and both conflicts reject before signup', async () => {
    for (const [conflicts, message] of [
        [{ username_taken: true, email_taken: false }, /username is already registered/],
        [{ username_taken: false, email_taken: true }, /email address is already registered/],
        [{ username_taken: true, email_taken: true }, /username and email address are already registered/],
    ]) {
        const auth = createAuthService({
            rpc: async (name, args) => {
                assert.equal(name, 'registration_conflicts');
                assert.deepEqual(args, { p_username: 'Seller', p_email: 'seller@example.com' });
                return { data: conflicts, error: null };
            },
            auth: { signUp: async () => assert.fail('duplicate must not reach signup') },
        });
        await assert.rejects(auth.register({ khubUsername: ' Seller ', email: ' Seller@Example.COM ', password: '123456' }), message);
    }
});

test('missing availability check fails closed instead of displaying signup success', async () => {
    const auth = createAuthService({
        rpc: async () => ({ error: { code: 'PGRST202' } }),
        auth: { signUp: async () => assert.fail('check failure must not reach signup') },
    });
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'seller@example.com', password: '123456' }), /temporarily unavailable/);
});

test('obfuscated duplicate email response is rejected even after an available precheck', async () => {
    const auth = createAuthService({ rpc: available, auth: {
        signUp: async () => ({ data: { user: { identities: [] }, session: null }, error: null }),
    } });
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'seller@example.com', password: '123456' }), /email address is already registered/);
});

test('explicit duplicate-email errors are reported clearly', async () => {
    const auth = createAuthService({ rpc: available, auth: {
        signUp: async () => ({ error: { code: 'user_already_exists', message: 'User already registered' } }),
    } });
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'seller@example.com', password: '123456' }), /email address is already registered/);
});

test('concurrent username conflict is rechecked after a trigger rejection', async () => {
    let checks = 0;
    const auth = createAuthService({
        rpc: async () => ({ data: { username_taken: ++checks > 1, email_taken: false }, error: null }),
        auth: { signUp: async () => ({ error: { code: 'unexpected_failure', message: 'Database error saving new user' } }) },
    });
    await assert.rejects(auth.register({ khubUsername: 'Seller', email: 'seller@example.com', password: '123456' }), /username is already registered/);
});


test('password recovery sends a normalized email and same-site reset URL', async () => {
    const auth = createAuthService({ auth: { async resetPasswordForEmail(email, options) {
        assert.equal(email, 'seller@example.com');
        assert.deepEqual(options, { redirectTo: 'https://auction.example/reset-password' });
        return { error: null };
    } }, rpc: () => assert.fail('recovery must not disclose account availability') });
    await auth.requestPasswordReset(' Seller@Example.COM ');
});

test('confirmation resend uses the signup type and confirmation route', async () => {
    const auth = createAuthService({ auth: { async resend(options) {
        assert.deepEqual(options, { type: 'signup', email: 'seller@example.com', options: { emailRedirectTo: 'https://auction.example/auth/confirm' } });
        return { error: null };
    } } });
    await auth.resendConfirmation(' Seller@Example.COM ');
});

test('recovery requests do not report success on email errors or rate limits', async () => {
    const limited = createAuthService({ auth: { resetPasswordForEmail: async () => ({ error: { status: 429, message: 'rate limit' } }) } });
    await assert.rejects(limited.requestPasswordReset('seller@example.com'), /Too many email requests/);
    const failed = createAuthService({ auth: { resend: async () => ({ error: { message: 'Email delivery is unavailable' } }) } });
    await assert.rejects(failed.resendConfirmation('seller@example.com'), /Email delivery is unavailable/);
});

test('invalid email addresses never reach recovery or resend', async () => {
    const auth = createAuthService(null);
    for (const email of ['', 'invalid', 'a'.repeat(255) + '@example.com']) {
        await assert.rejects(auth.requestPasswordReset(email), /valid email/);
        await assert.rejects(auth.resendConfirmation(email), /valid email/);
    }
});

test('password update validates before sending and preserves server errors', async () => {
    let updates = 0;
    const auth = createAuthService({ auth: { async updateUser(input) {
        updates++;
        assert.deepEqual(input, { password: 'new password' });
        return { error: new Error('Password must be different from the old password') };
    } } });
    await assert.rejects(auth.updatePassword('123'), /at least 6/);
    assert.equal(updates, 0);
    await assert.rejects(auth.updatePassword('new password'), /different from the old/);
    assert.equal(updates, 1);
});
