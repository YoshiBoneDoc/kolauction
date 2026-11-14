import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

// Exercise component handlers and rendered controls with a deterministic hook
// harness. This supplements database authorization tests; it is not a browser.
const require = createRequire(import.meta.url);
const code = readFileSync(new URL('../src/components/AdminEscrowPromotion.jsx', import.meta.url), 'utf8')
    .replace("from 'react'", "from 'promotion-test-hooks'")
    .replace("from '../lib/supabase'", "from 'promotion-test-backend'")
    .replace("from '../lib/escrowPromotionService'", "from 'promotion-test-service'");
const { outputFiles } = buildSync({ stdin: { contents: code, loader: 'jsx' }, bundle: true, write: false,
    platform: 'node', format: 'cjs', jsx: 'automatic', packages: 'external', external: ['promotion-test-*', 'react/jsx-runtime'] });
function fixture() {
    const state = [], effects = []; let cursor = 0, fail = false, invalidations = 0;
    const calls = [];
    const config = { name:'Giving Thanks: November Promotion', description:'Shared allowance', mode:'lower', tiers:[0,1,2,3,4], allowance:'20000000', donor_waiver:true, sell:[{from:0,bps:200}], buy:[{from:0,bps:200}], info_message:'November info', form_message:'November form' };
    let live = {id:'nov',revision:1,legacy:true,state:'published',config,starts_at:'2026-11-03T00:00:00Z',ends_at:null,messages:{info:'November info',form:'November form'}};
    let draft;
    const hooks = {
        useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
            return [state[i], value => { state[i] = typeof value === 'function' ? value(state[i]) : value; }]; },
        useEffect(callback, deps) { const i = cursor++; if (!state[i] || deps.some((v,j) => v !== state[i][j])) { state[i] = deps; effects.push(callback); } },
    };
    const backend = { supabase: { async rpc(name, args = {}) {
        calls.push({ name, args });
        if (fail) { fail = false; return { error: { message: 'Connection failed' } }; }
        if (args.p_action === 'save') { draft={id:'draft',revision:1,state:'draft',config:args.p_config,starts_at:null,ends_at:null,messages:{info:'Generated info',form:'Generated form'}}; return {data:draft}; }
        if (args.p_action === 'preview') return {data:{...draft,conflicts:[],confirmation:'reviewed-revision',examples:[],messages:{info:'Generated info',form:'Generated form'}}};
        if (args.p_action === 'end') live = {...live,state:'ended'};
        if (args.p_action === 'publish') draft={...draft,state:'published'};
        return { data: { engine_enabled:true, live_id:live.state==='published'?'nov':null,promotions:[live,...(draft?[draft]:[])] } };
    } } };
    const compiled = { exports: {} };
    const mockedRequire = name => name === 'promotion-test-hooks' ? hooks : name === 'promotion-test-backend' ? backend
        : name === 'promotion-test-service' ? { escrowPromotion: { invalidate() { invalidations++; } } } : require(name);
    new Function('require', 'module', 'exports', outputFiles[0].text)(mockedRequire, compiled, compiled.exports);
    return { calls, fail: () => { fail = true; }, invalidations: () => invalidations,
        render() { cursor = 0; return compiled.exports.default(); },
        async effects() { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)); } };
}
function elements(tree, type) {
    if (!tree || typeof tree !== 'object') return [];
    if (Array.isArray(tree)) return tree.flatMap(child => elements(child,type));
    return [...(tree.type === type ? [tree] : []), ...elements(tree.props?.children,type)];
}
function button(tree, text) { return elements(tree,'button').find(node => node.props.children === text); }

test('ending November requires explicit confirmation and refreshes metadata', async () => {
    const f = fixture(); f.render(); await f.effects();
    button(f.render(),'End promotion…').props.onClick();
    assert.equal(f.calls.length,1);
    await button(f.render(),'Confirm').props.onClick();
    const write=f.calls.find(c=>c.args.p_action==='end');
    assert.equal(write.args.p_confirmation,'CONFIRM');
    assert.equal(write.args.p_revision,1);
    assert.equal(f.invalidations(),1);
});

test('saving and previewing never publish; editing invalidates the reviewed preview', async () => {
    const f=fixture(); f.render(); await f.effects();
    await button(f.render(),'Save and preview').props.onClick();
    assert.ok(f.calls.some(c=>c.args.p_action==='save'));
    assert.ok(f.calls.some(c=>c.args.p_action==='preview'));
    assert.equal(f.invalidations(),0);
    assert.ok(!f.calls.some(c=>c.args.p_action==='publish'));
    const name=elements(f.render(),'input').find(n=>n.props.maxLength===100);
    name.props.onChange({target:{value:'Changed'}});
    assert.equal(button(f.render(),'Publish / schedule…'),undefined);
});

test('publication requires a second confirmation with exact preview revision', async () => {
    const f=fixture(); f.render(); await f.effects();
    await button(f.render(),'Save and preview').props.onClick();
    button(f.render(),'Publish / schedule…').props.onClick();
    assert.ok(!f.calls.some(c=>c.args.p_action==='publish'));
    await button(f.render(),'Confirm').props.onClick();
    const write=f.calls.find(c=>c.args.p_action==='publish');
    assert.equal(write.args.p_confirmation,'reviewed-revision');
    assert.equal(write.args.p_revision,1);
    assert.equal(f.invalidations(),1);
});

test('uncertain mutations reconcile status and remove stale confirmation', async () => {
    const f=fixture(); f.render(); await f.effects();
    button(f.render(),'End promotion…').props.onClick();f.fail();
    await button(f.render(),'Confirm').props.onClick();
    assert.equal(button(f.render(),'Confirm'),undefined);
    assert.equal(f.calls.at(-1).args.p_action,undefined);
    assert.equal(f.invalidations(),0);
});
