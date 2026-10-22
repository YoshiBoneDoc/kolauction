import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createSiteBannerService, readBannerDismissal, dismissBanner } from '../src/lib/siteBanner.js';

let active;
function state(initial) {
    const h = active, i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = initial;
    return [h.slots[i], next => { h.slots[i] = typeof next === 'function' ? next(h.slots[i]) : next; }];
}
const { outputFiles } = buildSync({
    stdin: { contents: `export {default as SiteBanner} from './src/components/SiteBanner.jsx';export {BannerManager} from './src/pages/AdminBanner.jsx';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' },
});
const compiled = { exports: {} }, require = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react'
    ? { ...React, useState: state, useRef: initial => state({ current: initial })[0], useEffect() {} } : require(name), compiled, compiled.exports);
const { SiteBanner, BannerManager } = compiled.exports;
function harness(component, slots = [], props = {}) {
    const h = { slots, cursor: 0 };
    h.render = () => { active = h; h.cursor = 0; return component(props); };
    return h;
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)]; }

test('banner dismisses one revision, persists across reloads, and shows the next announcement', () => {
    const saved = new Map(), storage = { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) };
    const oldWindow = globalThis.window;
    globalThis.window = { localStorage: storage };
    try {
        const h = harness(SiteBanner, [{ revision: 'first', message: '<script>alert(1)</script>\nMessage' }, null]);
        const tree = h.render();
        const html = renderToStaticMarkup(tree);
        assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
        nodes(tree).find(node => node.props?.['aria-label'] === 'Dismiss announcement').props.onClick();
        assert.equal(h.render(), null);
        assert.equal(readBannerDismissal(storage), 'first');
        assert.equal(harness(SiteBanner, [h.slots[0], readBannerDismissal(storage)]).render(), null);
        h.slots[0] = { revision: 'second', message: 'New announcement' };
        assert.match(renderToStaticMarkup(h.render()), /New announcement/);
    } finally { globalThis.window = oldWindow; }
});

test('dismissal works when browser storage is unavailable and no banner stays empty', () => {
    assert.equal(harness(SiteBanner).render(), null);
    const broken = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
    assert.equal(readBannerDismissal(broken), null);
    assert.doesNotThrow(() => dismissBanner(broken, 'x'));
    const oldWindow = globalThis.window;
    globalThis.window = { get localStorage() { throw Error('blocked'); } };
    try {
        const h = harness(SiteBanner, [{ revision: 'x', message: 'Message' }, null]);
        nodes(h.render()).find(node => node.type === 'button').props.onClick();
        assert.equal(h.render(), null);
    } finally { globalThis.window = oldWindow; }
});

test('administrator saves text and visibility once while a request is pending, and retains errors for recovery', async () => {
    let resolve, calls = [];
    const service = { save: (...args) => { calls.push(args); return new Promise(done => { resolve = done; }); } };
    const h = harness(BannerManager, [true, '  Important update  ', true], { service });
    const submit = () => nodes(h.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} });
    const saving = submit(); await submit();
    assert.deepEqual(calls, [['Important update', true]]);
    resolve({ message: 'Important update', active: true }); await saving;
    assert.match(renderToStaticMarkup(h.render()), /Announcement published/);
    service.save = async () => { throw Error('Administrator access required.'); };
    await submit(); assert.match(renderToStaticMarkup(h.render()), /Administrator access required/);
    assert.equal(h.slots[1], 'Important update');
});

test('announcement service uses guarded RPCs and surfaces missing configuration and server errors', async () => {
    const calls = [];
    const service = createSiteBannerService({ rpc: async (...args) => { calls.push(args); return { data: { active: true } }; } });
    await service.read(); await service.manage(); await service.save('Hello', false);
    assert.deepEqual(calls, [['read_site_banner', undefined], ['read_admin_site_banner', undefined], ['save_site_banner', { p_message: 'Hello', p_active: false }]]);
    await assert.rejects(createSiteBannerService(null).read(), /temporarily unavailable/);
    await assert.rejects(createSiteBannerService({ rpc: async () => ({ error: { message: 'Forbidden' } }) }).manage(), /Forbidden/);
});
