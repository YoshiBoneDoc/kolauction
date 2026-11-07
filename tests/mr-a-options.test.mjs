import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
test('editing the rate does not reload the quote or restore a deliberately cleared value', async () => {
    const output = await build({ entryPoints: ['src/components/MrAPaymentOptions.jsx'], bundle: true, write: false, platform: 'node',
        format: 'cjs', packages: 'external', jsx: 'automatic', plugins: [{ name: 'quote-fixture', setup(build) {
            build.onLoad({ filter: /src\/lib\/supabase\.js$/ }, () => ({ contents: `export const supabase={rpc:async()=>({data:[{item_id:194,available:true,price_meat:70000000,observed_at:new Date(Date.now()-1000).toISOString(),checked_at:new Date(Date.now()-1000).toISOString()}]})};` }));
        } }] });
    let cursor = 0, effects = [], rate = null;
    const slots = [];
    const compiled = { exports: {} };
    new Function('require', 'module', 'exports', output.outputFiles[0].text)(name => name === 'react' ? {
        ...React, useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], next => { slots[i] = next; }]; },
        useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
        useEffect: (fn, deps) => { const i = cursor++; const old = slots[i]; if (!old || deps.some((v, j) => v !== old[j])) { effects.push(fn); slots[i] = deps; } },
    } : require(name), compiled, compiled.exports);
    const changes = [];
    const onChange = (enabled, next) => { changes.push([enabled, next]); rate = next; };
    const render = () => { cursor = 0; const tree = compiled.exports.default({ enabled: true, rate, onChange }); const work = effects; effects = []; work.forEach(fn => fn()); return tree; };
    const nodes = tree => tree && typeof tree === 'object' ? [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)] : [];
    render();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rate, 70_000_000);
    const field = nodes(render()).find(node => node.props?.['aria-label'] === 'Meat per Mr. A');
    assert.equal(field.props.value, '70,000,000');
    field.props.onChange({ target: { value: '71,000,000' } });
    assert.equal(rate, 71_000_000);
    field.props.onChange({ target: { value: '' } });
    render();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(rate, null);
    assert.deepEqual(changes, [[true, 70_000_000], [true, 71_000_000], [true, null]]);
    for (const [text, expected] of [['81m', 81_000_000], ['81k', 81_000], ['81b', 81_000_000_000], ['70.5M', 70_500_000]]) {
        field.props.onChange({ target: { value: text } });
        assert.equal(rate, expected);
        nodes(render()).find(node => node.props?.['aria-label'] === 'Meat per Mr. A').props.onBlur();
        assert.equal(nodes(render()).find(node => node.props?.['aria-label'] === 'Meat per Mr. A').props.value, expected.toLocaleString('en-US'));
    }
    field.props.onChange({ target: { value: '' } });
    render();
    const arrow = direction => nodes(render()).find(node => node.props?.['aria-label'] === `${direction} Mr. A valuation by 1%`);
    arrow('Increase').props.onClick();
    assert.equal(rate, 70_700_000);
    arrow('Decrease').props.onClick();
    assert.equal(rate, 69_993_000);
    for (let i = 0; i < 10; i++) arrow('Increase').props.onClick();
    assert.equal(rate, 73_500_000);
    for (let i = 0; i < 20; i++) arrow('Decrease').props.onClick();
    assert.equal(rate, 66_500_000);
});
