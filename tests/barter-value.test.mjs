import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const { outputFiles } = buildSync({ entryPoints: [fileURLToPath(new URL('../src/lib/barter.js', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', define: { 'import.meta.env': '{}' } });
const mod={exports:{}};
new Function('require','module','exports',outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {offerValue,offerDescription}=mod.exports;
test('offer estimate sums Meat and current item quotes exactly and fails closed for missing/stale quotes',()=>{
 const stamp=new Date().toISOString();
 const prices=new Map([[2,{available:true,price_meat:12345,observed_at:stamp,checked_at:stamp}]]);
 assert.equal(offerValue(500,[{id:2,quantity:3}],prices),37535);
 assert.equal(offerValue(0,[],prices),0);
 assert.equal(offerValue(20_000_000_000,[{id:2,quantity:1}],prices),null);
 assert.equal(offerValue(0,[{id:3,quantity:1}],prices),null);
 assert.equal(offerValue(0,[{id:2,quantity:0}],prices),null);
 prices.get(2).observed_at=new Date(Date.now()-27*3600000).toISOString();
 assert.equal(offerValue(0,[{id:2,quantity:1}],prices),null);
});
test('compact offer text omits unit quantities but retains every component and Meat',()=>{
 assert.equal(offerDescription({meat:500,items:[{name:'apple',quantity:1},{name:'clover',quantity:2}]}),'500 Meat + apple + 2 × clover');
});
