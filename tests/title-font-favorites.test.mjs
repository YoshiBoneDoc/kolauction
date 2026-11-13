import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildSync } from 'esbuild';
import * as React from 'react';
const require = createRequire(import.meta.url);
const source = readFileSync('src/components/RandomTitleFont.jsx', 'utf8').replace("from 'react'", "from 'test-hooks'");
const code = buildSync({ stdin: { contents: source, loader: 'jsx' }, write: false, platform: 'node', format: 'cjs', jsx: 'automatic' }).outputFiles[0].text;
test('favorites persist, preview joins history, Previous and Reset restore original, cleanup restores title', async () => {
    const originalStorage = globalThis.localStorage;
    const stored = new Map();
    globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    try {
        let cursor = 0; const slots = [], effects = [], cleanups = [];
        const hooks = {
            useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
            useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
            useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i][n])) { slots[i] = deps; effects.push(fn); } },
        };
        const module = { exports: {} };
        const fontApi = { fontCatalog: async () => ['Example'], randomFamily: () => 'Example', loadTitleFont: async () => ({ remove() {} }) };
        new Function('require', 'module', 'exports', code)(name => name === 'test-hooks' ? hooks : name === '../lib/randomTitleFont' ? fontApi : require(name), module, module.exports);
        const style = { removeProperty(key) { delete this[key === 'font-family' ? 'fontFamily' : 'fontWeight']; } };
        const titleRef = { current: { style } };
        function nodes(n) { return !n || typeof n !== 'object' ? [] : [n, ...React.Children.toArray(n.props?.children).flatMap(nodes)]; }
        let tree;
        function render() { cursor = 0; tree = nodes(module.exports.default({ titleRef })); while (effects.length) { const cleanup = effects.shift()(); if (cleanup) cleanups.push(cleanup); } }
        function button(label) { return tree.find(n => n.type === 'button' && n.props['aria-label'] === label); }
        render();
        // The first preview starts automatically and remains in history.
        await new Promise(resolve => setImmediate(resolve)); render();
        assert.equal(style.fontFamily, '"Example"');
        assert.equal(button('Previous font').props.disabled, false);
        await button('Restore Newsreader').props.onClick(); render();
        await button('Favorite font').props.onClick(); render();
        assert.deepEqual(JSON.parse(stored.get('khub.title-font-favorites.v1')), ['Newsreader']);
        assert.equal(button('Remove favorite').props['aria-pressed'], true);
        await button('Random font').props.onClick(); render();
        assert.equal(style.fontFamily, '"Example"');
        await button('Favorite font').props.onClick(); render();
        assert.deepEqual(JSON.parse(stored.get('khub.title-font-favorites.v1')), ['Newsreader', 'Example']);
        await button('Previous font').props.onClick(); render();
        assert.equal(style.fontFamily, '"Newsreader"');
        await button('Remove favorite').props.onClick(); render();
        assert.deepEqual(JSON.parse(stored.get('khub.title-font-favorites.v1')), ['Example']);
        await button('Random font').props.onClick(); render();
        await button('Restore Newsreader').props.onClick(); render();
        assert.equal(style.fontWeight, '500');
        assert.equal(button('Previous font').props.disabled, true);
        // Deterministic choices verify full cycles independently of navigation history.
        fontApi.fontCatalog = async () => ['Newsreader', 'A', 'B', 'C'];
        fontApi.randomFamily = choices => choices[0] ?? null;
        await button('Random font').props.onClick(); render();
        assert.equal(style.fontFamily, '"A"');
        await button('Previous font').props.onClick(); render();
        await button('Random font').props.onClick(); render();
        assert.equal(style.fontFamily, '"B"');
        await button('Restore Newsreader').props.onClick(); render();
        await button('Random font').props.onClick(); render();
        assert.equal(style.fontFamily, '"C"');
        const nextCycle = [];
        for (let i = 0; i < 4; i++) {
            await button('Random font').props.onClick(); render();
            nextCycle.push(style.fontFamily);
        }
        assert.deepEqual(nextCycle, ['"Newsreader"', '"A"', '"B"', '"C"']);
        for (const cleanup of cleanups) cleanup();
        assert.equal(style.fontFamily, undefined);
        assert.deepEqual(JSON.parse(stored.get('khub.title-font-favorites.v1')), ['Example']);
    } finally { globalThis.localStorage = originalStorage; }
});
