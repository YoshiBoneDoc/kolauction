import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { loadWallOfShame } from '../src/lib/wallOfShame.js';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import WallOfShame, { BanPortrait } from './src/pages/WallOfShame.jsx';
    import { UserContext } from './src/context/UserContext.jsx';
    export const renderPortrait = (entry,showIdentity=true) => renderToStaticMarkup(<BanPortrait entry={entry} showIdentity={showIdentity} />);
    export const renderPage = () => renderToStaticMarkup(<StaticRouter><UserContext.Provider value={{}}><WallOfShame /></UserContext.Provider></StaticRouter>);
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', define: { 'import.meta.env': '{}' }, jsx: 'automatic' });
const compiled = { exports: {} }, requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);

const entry = { id: 'fixture', kol_player_name: '<script>Fake</script>', kol_player_id: 12345,
    public_reason: '<img src=x onerror=alert(1)>', banned_at: '2026-10-19T12:00:00Z', expires_at: null };

test('gallery reads bounded pages through its public projection', async () => {
    const data = { entries: [], total: 0 };
    assert.deepEqual(await loadWallOfShame({ rpc: async (name, params) => {
        assert.equal(name, 'khub_wall_of_shame'); assert.deepEqual(params, { p_offset: 24, p_limit: 24 });
        return { data };
    } }, 1), data);
});
test('unavailable gallery never reports an empty successful collection or exposes database errors', async () => {
    await assert.rejects(loadWallOfShame(null), /not connected/);
    await assert.rejects(loadWallOfShame({ rpc: async () => ({ error: { message: 'private SQL detail' } }) }), { message: 'The gallery could not be loaded. Please try again later.' });
    await assert.rejects(loadWallOfShame({ rpc: async () => ({ data: {} }) }), /could not be loaded/);
});
test('portraits escape names and reasons and distinguish temporary from permanent bans', () => {
    const html = compiled.exports.renderPortrait(entry);
    assert.match(html, /Permanent ban/); assert.match(html, /KoL #12345/);
    assert.doesNotMatch(html, /<script>|<img src=x/);
    const temporary = compiled.exports.renderPortrait({ ...entry, expires_at: '2026-11-19T12:00:00Z' });
    assert.match(temporary, /Temporary ban/); assert.match(temporary, /Until/);
});
test('gallery route initially shows loading rather than fabricated banned players', () => {
    const html = compiled.exports.renderPage();
    assert.match(html, /Wall of Shame/); assert.match(html, /Opening the gallery/);
    assert.match(html, /Submit an appeal/); assert.doesNotMatch(html, /shame-nameplate/);
});

test('masked gallery portraits contain no player name, number or identifying reason',()=>{
    const html=compiled.exports.renderPortrait(entry,false);
    assert.doesNotMatch(html,/12345|Fake|onerror/);
    assert.match(html,/Banned player/);
});
