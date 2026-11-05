import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import React from 'react';
const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: "export {default} from './src/components/RenderBoundary.jsx';", resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic' });
const compiled = { exports: {} };
new Function('require','module','exports',outputFiles[0].text)(require,compiled,compiled.exports);
const Boundary = compiled.exports.default;
function nodes(element) { return !element || typeof element !== 'object' ? [] : [element, ...React.Children.toArray(element.props?.children).flatMap(nodes)]; }
test('render and rejected-page failures offer recovery rather than a blank result', () => {
    for (const error of [new TypeError('Missing state'), new Error('Failed to fetch dynamically imported module')]) {
        const boundary = new Boundary({ children: 'page' });
        assert.equal(boundary.render(), 'page');
        boundary.state = Boundary.getDerivedStateFromError(error);
        const fallback = nodes(boundary.render());
        assert.equal(fallback[0].props.role, 'alert');
        assert.ok(fallback.some(n => n.type === 'button' && n.props.children === 'Reload page'));
        assert.ok(fallback.some(n => n.type === 'a' && n.props.href === '/'));
        assert.equal(new Boundary({ children: 'next route' }).render(), 'next route');
    }
});
