import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthRedirectUrls, readAuthLink, recoveryUserForEvent } from '../src/lib/authLinks.js';

const emptyLink = readAuthLink({});
const session = { user: { id: 'buyer' }, access_token: 'validated-token' };

test('email redirects keep localhost ports and production HTTPS domains', () => {
    assert.deepEqual(getAuthRedirectUrls('http://localhost:5173'), {
        confirmation: 'http://localhost:5173/auth/confirm', recovery: 'http://localhost:5173/reset-password',
    });
    assert.deepEqual(getAuthRedirectUrls('https://kbay.example/some-path?next=https://other.example'), {
        confirmation: 'https://kbay.example/auth/confirm', recovery: 'https://kbay.example/reset-password',
    });
    assert.throws(() => getAuthRedirectUrls('javascript:alert(1)'), /Invalid website/);
});

test('expired link errors are recognized in both fragment and query without reflecting URL content', () => {
    for (const location of [{ hash: '#error=access_denied&error_code=otp_expired&error_description=private' }, { search: '?error_description=private' }]) {
        const result = readAuthLink(location);
        assert.match(result.error, /invalid or expired/);
        assert.doesNotMatch(result.error, /private/);
    }
});

test('only recovery events or a matching validated link establish recovery intent', () => {
    assert.equal(recoveryUserForEvent('PASSWORD_RECOVERY', session, null, emptyLink), 'buyer');
    const link = readAuthLink({ hash: '#type=recovery&access_token=validated-token' });
    assert.equal(recoveryUserForEvent('INITIAL_SESSION', session, null, link), 'buyer');
    assert.equal(recoveryUserForEvent('INITIAL_SESSION', session, null, emptyLink), null);
    assert.equal(recoveryUserForEvent('SIGNED_IN', session, null, emptyLink), null);
});

test('a failed recovery link cannot authorize resetting an unrelated existing session', () => {
    const invalidToken = readAuthLink({ hash: '#type=recovery&access_token=invalid-token' });
    assert.equal(recoveryUserForEvent('INITIAL_SESSION', session, null, invalidToken), null);
    const expired = readAuthLink({ hash: '#type=recovery&error_code=otp_expired' });
    assert.equal(recoveryUserForEvent('INITIAL_SESSION', session, 'buyer', expired), null);
});

test('refreshing or refocusing the same recovery session preserves the reset flow', () => {
    for (const event of ['INITIAL_SESSION', 'TOKEN_REFRESHED', 'SIGNED_IN']) {
        assert.equal(recoveryUserForEvent(event, session, 'buyer', emptyLink), 'buyer');
    }
});

test('signout, session expiry, or another account clears recovery intent', () => {
    assert.equal(recoveryUserForEvent('SIGNED_OUT', session, 'buyer', emptyLink), null);
    assert.equal(recoveryUserForEvent('INITIAL_SESSION', null, 'buyer', emptyLink), null);
    assert.equal(recoveryUserForEvent('SIGNED_IN', { ...session, user: { id: 'seller' } }, 'buyer', emptyLink), null);
});
