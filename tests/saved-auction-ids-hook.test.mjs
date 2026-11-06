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
let user = null, savedState = null, authorizationScope;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => {
    if (name === 'react') return {
        useContext: () => ({ currentUser: user, authorizationScope }),
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

test('token scope changes hide saved IDs until the new authorization read completes', () => {
    user = { id: 'owner' };
    authorizationScope = 'new-token';
    savedState = { userId: 'owner', scope: 'old-token', ids: new Set(['private']) };
    assert.deepEqual([...read()], []);
    savedState.scope = 'new-token';
    assert.deepEqual([...read()], ['private']);
    authorizationScope = undefined;
});
