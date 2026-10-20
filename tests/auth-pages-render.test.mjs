import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = buildSync({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { StaticRouter } from 'react-router-dom';
            import App from './src/App.jsx';
            import { UserContext } from './src/context/UserContext.jsx';
            export function render(path, auth = {}) {
                return renderToStaticMarkup(
                    <StaticRouter location={path}>
                        <UserContext.Provider value={auth}><App /></UserContext.Provider>
                    </StaticRouter>
                );
            }
        `,
        resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)((name) => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;

test('recovery and former resend routes explain authenticated KMail recovery without email', () => {
    for (const path of ['/forgot-password', '/resend-confirmation']) {
        assert.match(render(path), /CREDENTIALS/);
        assert.doesNotMatch(render(path), /type="email"/);
        assert.match(render(path), /old password stops working/);
    }
});

test('login and registration expose account recovery and resend navigation', () => {
    const login = render('/login');
    assert.match(login, /href="\/forgot-password"/);
    assert.match(login, /href="\/register"/);
    assert.doesNotMatch(login, /href="\/resend-confirmation"/);
    const register = render('/register');
    assert.match(register, /REGISTER/);
    assert.match(register, /kHub username \(KH_ followed by your KoL name\) and temporary password/);
    assert.doesNotMatch(register, /Your username will be|Custom usernames are not available/);
    assert.doesNotMatch(register, /register-username|type="text"/);
    assert.doesNotMatch(register, /type="email"|type="password"|href="\/resend-confirmation"/);
    assert.match(login, /kHub Username/);
    assert.match(login, /KH_Your KoL name/);
});

test('ordinary signed-in sessions can change their temporary password', () => {
    const html = render('/reset-password', { currentUser: { id: 'buyer' }, canResetPassword: false });
    assert.match(html, /id="new-password"/);
    assert.match(html, /minLength="12"/);
    assert.doesNotMatch(render('/change-password'), /id="new-password"/);
});

test('validated recovery sessions render both password fields', () => {
    const html = render('/reset-password', { canResetPassword: true });
    assert.match(html, /id="new-password"/);
    assert.match(html, /id="confirm-password"/);
    assert.match(html, /Update password/);
});

test('expired links show an actionable error and never a password form', () => {
    const auth = { canResetPassword: true, authLinkError: 'This email link is invalid or expired. Please request a new one.' };
    const html = render('/reset-password', auth);
    assert.match(html, /Recover your login/);
    assert.doesNotMatch(html, /id="new-password"/);
    assert.match(render('/auth/confirm', auth), /Resend confirmation email/);
});

test('confirmed email callback shows success without relying on a profile fetch', () => {
    assert.match(render('/auth/confirm', { emailConfirmed: true }), /Your email address is confirmed/);
    assert.doesNotMatch(render('/auth/confirm', {}), /Your email address is confirmed/);
});
