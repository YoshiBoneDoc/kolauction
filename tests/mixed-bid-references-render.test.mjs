import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const require=createRequire(import.meta.url);
let bids;
const code=buildSync({stdin:{contents:readFileSync('src/components/BidHistory.jsx','utf8'),loader:'jsx'},write:false,platform:'node',format:'cjs',jsx:'automatic'}).outputFiles[0].text;
const module={exports:{}};
new Function('require','module','exports',code)(name=>name==='../hooks/useBidHistory'?()=>({bids,loading:false,hasMore:false}):require(name),module,module.exports);
const base={id:'bid',bidder:'Test bidder',amount:100000000,timestamp:Date.now(),paymentMrA:1,paymentMeat:23760000};
const render=()=>renderToStaticMarkup(React.createElement(module.exports.default,{auction:{id:'auction',mrARate:76240000,bidCount:1},currentUser:{id:'viewer'},result:{hasWinner:false}}));
test('mixed bid composition keeps the administrator acceptance and both asset refund references visible',()=>{
 bids=[{...base,adminDeliveryReferences:[{reference:'D-3442',label:'Accepted',state:'sent'},{reference:'D-3494',label:'Bid refund',state:'sent'},{reference:'D-3495',label:'Bid refund',state:'pending'}]}];
 const html=render();assert.match(html,/Administrator message references/);assert.match(html,/Accepted:/);assert.match(html,/D-3442/);assert.match(html,/D-3494/);assert.match(html,/D-3495/);assert.match(html,/\(sent\)/);assert.match(html,/\(pending\)/);assert.match(html,/23,760,000 Meat/);assert.match(html,/alt="Mr. A"/);
});
test('absent server references are never fabricated for a mixed Direct bid',()=>{
 bids=[{...base,adminDeliveryReferences:[]}];const html=render();assert.doesNotMatch(html,/Administrator message references|Accepted:|Bid refund:/);assert.match(html,/23,760,000 Meat/);
});
