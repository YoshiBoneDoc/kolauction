import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const {outputFiles}=buildSync({stdin:{contents:"export { SellerLeaderboardHonorsView } from './src/components/SellerLeaderboardHonors.jsx';",resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',define:{'import.meta.env':'{}'}});
const compiled={exports:{}};
new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),compiled,compiled.exports);
const view=props=>renderToStaticMarkup(React.createElement(compiled.exports.SellerLeaderboardHonorsView,props));
test('a seller can display all three category positions with category colors and symbols',()=>{
    const html=view({sellerId:'player',data:{volume:[{id:'player',rank:1}],trades:[{id:'player',rank:3}],donors:[{id:'player',rank:2}]}});
    assert.match(html,/Ranks first in meat traded/);
    assert.match(html,/Ranks third in total trades/);
    assert.match(html,/Ranks second in top donors/);
    assert.ok(html.indexOf('Ranks first') < html.indexOf('Ranks second'));
    assert.ok(html.indexOf('Ranks second') < html.indexOf('Ranks third'));
    for(const color of ['#9BBFF5','#76D0C4','#F2C66D']) assert.ok(html.includes(color));
    assert.equal((html.match(/<svg/g)||[]).length,3);
    assert.equal((html.match(/M7 3h10v5/g)||[]).length,2);
});
test('honors show only the viewed player and only top-three positions',()=>{
    assert.equal(view({sellerId:'other',data:{volume:[{id:'player',rank:1}]}}),'');
    assert.equal(view({sellerId:'player',data:{volume:[{id:'player',rank:4}],trades:[{id:'player',rank:null}]}}),'');
    assert.equal(view({sellerId:'player',data:null}),'');
});
