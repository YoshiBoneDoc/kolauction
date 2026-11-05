import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({
    stdin: { contents: "export {default} from './src/hooks/useMySavedAuctionIds.js';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    external: ['../context/UserContext', '../lib/supabase'],
});
let user = null, savedState = null;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => {
    if (name === 'react') return {
        useContext: () => ({ currentUser: user }),
        useState: () => [savedState, () => {}],
        useEffect: () => {},
        useSyncExternalStore: () => {},
    };
    if (name === '../context/UserContext') return { UserContext: {} };
    if (name === '../lib/supabase') return { supabase: null };
    return require(name);
}, compiled, compiled.exports);
const read = compiled.exports.default;

test('guest auction browsing renders with empty saved IDs before any profile is loaded', () => {
    user = null; savedState = null;
    assert.deepEqual([...read()], []);
});
test('saved IDs remain scoped to the current viewer, including logout', () => {
    savedState = { userId: 'owner', ids: new Set(['saved-auction']) };
    user = { id: 'owner' };
    assert.deepEqual([...read()], ['saved-auction']);
    user = { id: 'another-user' };
    assert.deepEqual([...read()], []);
    user = null;
    assert.deepEqual([...read()], []);
});
