import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { fileURLToPath } from 'node:url';
import { countdown, validateAppealImage, evidenceDataUrl, createAccountRestrictionService } from '../src/lib/accountRestrictions.js';
import { createBugReportService } from '../src/lib/bugReports.js';

test('ban countdown handles days, final seconds and expiry without displaying negative time', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    assert.equal(countdown('2026-10-22T14:03:04Z', now), '1d 2h 3m 4s');
    assert.equal(countdown('2026-10-21T12:00:01Z', now), '0h 0m 1s');
    assert.equal(countdown('2026-10-21T11:00:00Z', now), 'Checking account status…');
});

test('appeal images reject executable formats, empty files and oversized evidence', () => {
    for (const file of [{ type: 'image/svg+xml', size: 50 }, { type: 'image/png', size: 0 }, { type: 'image/jpeg', size: 2097153 }]) {
        assert.throws(() => validateAppealImage(file), /PNG, JPEG or WebP/);
    }
    validateAppealImage({ type: 'image/png', size: 2097152 });
    assert.equal(evidenceDataUrl({ mime_type: 'image/png', base64: 'aGVsbG8=' }), 'data:image/png;base64,aGVsbG8=');
    for (const data of [null, { mime_type: 'image/svg+xml', base64: 'aGVsbG8=' }, { mime_type: 'image/png', base64: '<script>' }]) {
        assert.throws(() => evidenceDataUrl(data), /could not be loaded/);
    }
});

test('admin restrictions submit exact targets, local expiry converted to ISO and reasons without changing trade ratings', async () => {
    const calls = [];
    const service = createAccountRestrictionService({ async rpc(name, args) { calls.push({ name, args }); return { data: name === 'read_admin_accounts' ? [] : null }; } });
    await service.search(' KH_Player ');
    const expiry = new Date(Date.now() + 86400000).toISOString();
    await service.save('target-id', ' Reviewed trade ', expiry);
    await service.save('target-id', ' Permanent restriction ');
    await service.lift('target-id', ' Appeal upheld ');
    assert.deepEqual(calls, [
        { name: 'read_admin_accounts', args: { p_search: 'KH_Player' } },
        { name: 'set_account_restriction', args: { p_user_id: 'target-id', p_reason: 'Reviewed trade', p_expires_at: expiry } },
        { name: 'set_account_restriction', args: { p_user_id: 'target-id', p_reason: 'Permanent restriction', p_expires_at: null } },
        { name: 'lift_account_restriction', args: { p_user_id: 'target-id', p_reason: 'Appeal upheld' } },
    ]);
    await assert.rejects(service.save('target-id', 'ok'), /reason/);
    await assert.rejects(service.save('target-id', 'Reason', '2020-01-01'), /future expiry/);
    assert.equal(calls.length, 4);
});

test('non-admin errors and malformed search responses are not treated as successful changes', async () => {
    const forbidden = createAccountRestrictionService({ async rpc() { return { error: { code: '42501', message: 'private server detail' } }; } });
    await assert.rejects(forbidden.search('Player'), /Administrator access required/);
    const malformed = createAccountRestrictionService({ async rpc() { return { data: {} }; } });
    await assert.rejects(malformed.search('Player'), /could not be loaded/);
});

test('appeal account lookup uses the report ID and rejects unavailable or unauthorized data', async () => {
    const calls = [];
    const account = { id: 'appellant-id', username: 'Appellant', is_banned: true };
    const service = createAccountRestrictionService({ async rpc(name, args) { calls.push({ name, args }); return { data: account }; } });
    assert.deepEqual(await service.reportAccount('appeal-id'), account);
    assert.deepEqual(calls, [{ name: 'read_appeal_account', args: { p_report_id: 'appeal-id' } }]);
    assert.equal(await createAccountRestrictionService({ async rpc() { return { data: null }; } }).reportAccount('missing'), null);
    await assert.rejects(createAccountRestrictionService({ async rpc() { return { data: [] }; } }).reportAccount('id'), /could not be loaded/);
    await assert.rejects(createAccountRestrictionService({ async rpc() { return { error: { code: '42501' } }; } }).reportAccount('id'), /Administrator access required/);
});

test('appeal history uses the report ID, validates events and preserves full reasons', async () => {
    const events = [{ id: 'ban-event-1', action: 'issued', created_at: '2026-10-20T12:00:00Z', reason: 'Full reason. '.repeat(80) }];
    const calls = [];
    const service = createAccountRestrictionService({ async rpc(name, args) { calls.push({ name, args }); return { data: events }; } });
    assert.deepEqual(await service.appealHistory('appeal-id'), events);
    assert.deepEqual(calls, [{ name: 'read_appeal_ban_history', args: { p_report_id: 'appeal-id' } }]);
    for (const data of [null, {}, [{ ...events[0], created_at: 'invalid' }]]) {
        await assert.rejects(createAccountRestrictionService({ async rpc() { return { data }; } }).appealHistory('id'), /history could not be loaded/);
    }
});

test('auction ban reviews keep completion decisions distinct from ban lifting and ticket resolution', async () => {
    const calls = [];
    const service = createAccountRestrictionService({ async rpc(name, args) { calls.push({ name, args }); return { data: name === 'read_auction_ban_reviews' ? [] : null }; } });
    assert.deepEqual(await service.auctions(), []);
    await service.reviewAuction('auction-id', 'buyer_complete', ' Evidence reviewed ');
    assert.deepEqual(calls, [
        { name: 'read_auction_ban_reviews', args: {} },
        { name: 'review_banned_auction', args: { p_auction_id: 'auction-id', p_action: 'buyer_complete', p_reason: 'Evidence reviewed' } },
    ]);
});

test('appeal image and body share one atomic request; admin evidence is fetched separately', async () => {
    const calls = [];
    const service = createBugReportService({ async rpc(name, args) { calls.push({ name, args }); return { data: { reference: 'B-1234' } }; } });
    await service.submitAppeal('request-id', ' Please review this restriction. ', { mime_type: 'image/png', base64: 'aGVsbG8=' });
    await service.readAppealEvidence('request-id');
    assert.deepEqual(calls, [
        { name: 'submit_ban_appeal_with_evidence', args: { p_request_id: 'request-id', p_body: 'Please review this restriction.', p_image_base64: 'aGVsbG8=', p_mime_type: 'image/png' } },
        { name: 'read_appeal_evidence', args: { p_report_id: 'request-id' } },
    ]);
});

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import BannedAccount from './src/components/BannedAccount.jsx';
    import AdminAccountControls from './src/components/AdminAccountControls.jsx';
    import SubmitAppeal from './src/pages/SubmitAppeal.jsx';
    import { UserContext, UserProvider } from './src/context/UserContext.jsx';
    export const provider = () => renderToStaticMarkup(<StaticRouter><UserProvider><p>Public website</p></UserProvider></StaticRouter>);
    export const ban = account => renderToStaticMarkup(<StaticRouter><BannedAccount account={account} onLogout={() => {}} /></StaticRouter>);
    export const admin = () => renderToStaticMarkup(<AdminAccountControls />);
    export const appeal = () => renderToStaticMarkup(<StaticRouter><UserContext.Provider value={{ signedInUserId: 'banned-id', restrictedAccount: { isBanned: true } }}><SubmitAppeal /></UserContext.Provider></StaticRouter>);
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', define: { 'import.meta.env': '{}' }, jsx: 'automatic', loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);

test('restricted account screens show a countdown only for temporary bans and retain appeal access', () => {
    const temporary = compiled.exports.ban({ banExpiresAt: '2027-01-01T00:00:00Z' });
    assert.match(temporary, /Your account is banned/); assert.match(temporary, /role="timer"/); assert.match(temporary, /href="\/submit-appeal"/);
    const permanent = compiled.exports.ban({ banExpiresAt: null });
    assert.match(permanent, /no expiry/); assert.doesNotMatch(permanent, /role="timer"/);
    assert.match(compiled.exports.admin(), /Account bans/);
    const appeal = compiled.exports.appeal();
    assert.match(appeal, /type="file"/); assert.match(appeal, /Only administrators/); assert.match(appeal, /Back to account status/);
});

test('account provider renders signed-out visitors without treating an absent user as a restriction', () => {
    assert.match(compiled.exports.provider(), /Public website/);
});
