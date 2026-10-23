import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { applyTheme, readThemePreference, resolveTheme, saveTheme, THEME_STORAGE_KEY } from '../src/lib/theme.js';

const boot = readFileSync(new URL('../public/theme.js', import.meta.url), 'utf8');
function environment(saved, dark = false) {
    const values = new Map(saved == null ? [] : [[THEME_STORAGE_KEY, saved]]);
    return { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        matchMedia: () => ({ matches: dark }) };
}

test('saved light/dark preferences override the system; absent or invalid preferences follow it', () => {
    for (const dark of [true, false]) for (const saved of [null, 'dark', 'light', 'invalid']) {
        const env = environment(saved, dark);
        const expected = ['light', 'dark'].includes(saved) ? saved : dark ? 'dark' : 'light';
        assert.equal(resolveTheme(env), expected);
        const root = { dataset: {}, style: {} };
        runInNewContext(boot, { localStorage: env.localStorage, window: env, document: { documentElement: root } });
        assert.equal(root.dataset.theme, expected);
        assert.equal(root.style.colorScheme, expected);
    }
});

test('switching themes stores the preference and sets the document and native control scheme', () => {
    const env = environment(null, true);
    const root = { dataset: {}, style: {} };
    saveTheme('light', env); applyTheme('light', root);
    assert.equal(readThemePreference(env), 'light'); assert.equal(resolveTheme(env), 'light');
    assert.deepEqual(root, { dataset: { theme: 'light' }, style: { colorScheme: 'light' } });
    saveTheme('dark', env); applyTheme('dark', root);
    assert.equal(resolveTheme(env), 'dark'); assert.equal(root.dataset.theme, 'dark');
});

test('blocked browser storage and missing browser APIs never prevent rendering or switching', () => {
    const env = { get localStorage() { throw Error('Storage blocked'); }, matchMedia: () => ({ matches: true }) };
    assert.equal(resolveTheme(env), 'dark'); assert.doesNotThrow(() => saveTheme('light', env));
    assert.equal(resolveTheme({}), 'light'); assert.doesNotThrow(() => applyTheme('dark'));
    const root = { dataset: {}, style: {} };
    const context = { window: env, document: { documentElement: root } };
    Object.defineProperty(context, 'localStorage', { get() { throw Error('Storage blocked'); } });
    runInNewContext(boot, context); assert.equal(root.dataset.theme, 'dark');
});
