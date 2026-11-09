import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const source=readFileSync('src/components/PendingTrades.jsx','utf8').replace("from 'react'","from 'test-hooks'");
const code=buildSync({stdin:{contents:source,loader:'jsx'},write:false,platform:'node',format:'cjs',jsx:'automatic'}).outputFiles[0].text;
function fixture(initial) {
 let context=initial,cursor=0,tree;const state=[],effects=[],opened=[],pages=[];
 const user={id:'buyer'};
 const hooks={useContext:key=>key==='user'?{currentUser:user}:context,useState(initial){const i=cursor++;if(!(i in state))state[i]=initial;return[state[i],value=>{state[i]=value;}];},useRef(initial){const i=cursor++;return state[i] ||= {current:initial};},useEffect(fn,deps){const i=cursor++;if(!state[i]||deps.some((v,n)=>v!==state[i][n])){state[i]=deps;effects.push(fn);}}};
 const module={exports:{}};
 new Function('require','module','exports',code)(name=>name==='test-hooks'?hooks:name==='../context/UserContext'?{UserContext:'user'}:name==='../context/AuctionsContext'?{AuctionsContext:'auctions'}:name==='react-router-dom'?{Link:'a'}:name==='../lib/bundles'?{auctionQuantityLabel:()=>'(2 items)'}:name==='../lib/formatMeat'?{formatCompactMeat:String}:name.includes('ConfirmTradeButton')?'confirm-trade':name.includes('TradeFeedback')?'trade-feedback':require(name),module,module.exports);
 context={...context,setPendingExpanded:value=>opened.push(value),setPendingPage:value=>pages.push(value)};
 function nodes(n){if(!n||typeof n!=='object')return[];if(typeof n.type==='function')return nodes(n.type(n.props));return[n,...React.Children.toArray(n.props?.children).flatMap(nodes)];}
 return {opened,pages,render(patch={}){context={...context,...patch};cursor=0;tree=nodes(module.exports.default());while(effects.length)effects.shift()();return tree;},button(label){return tree.find(n=>n.type==='button'&&n.props['aria-label']===label);}};
}
const trade=n=>({id:`trade-${n}`,item:`Item ${n}`,sellerId:'seller',winnerId:'buyer',quantity:1,finalPrice:100,status:'awaiting_trade',escrowMode:false});
test('pending summary opens automatically and an unchanged stale summary does not loop',()=>{
 const f=fixture({pendingExpanded:false,pendingHasLoaded:true,pendingTotal:1,pendingUpdatedAt:100});f.render();assert.deepEqual(f.opened,[true]);f.render();assert.deepEqual(f.opened,[true]);
});
test('full cards navigate locally with no collapse control, and one trade hides navigation',()=>{
 const f=fixture({pendingExpanded:true,pendingTrades:[trade(1),trade(2)],pendingTotal:2});
 let tree=f.render();assert.ok(tree.some(n=>n.type==='a'&&n.props.to==='/auction/trade-1'));assert.equal(f.button('Previous pending trade').props.disabled,true);
 f.button('Next pending trade').props.onClick();tree=f.render();assert.ok(tree.some(n=>n.type==='a'&&n.props.to==='/auction/trade-2'));assert.equal(f.button('Next pending trade').props.disabled,true);assert.deepEqual(f.pages,[]);
 tree=f.render({pendingTrades:[trade(1)],pendingTotal:1});assert.equal(f.button('Next pending trade'),undefined);assert.ok(!tree.some(n=>n.props.children==='Hide trade details'));
});
test('navigation crosses only the existing bounded page boundary',()=>{
 const f=fixture({pendingExpanded:true,pendingTrades:Array.from({length:12},(_,i)=>trade(i)),pendingTotal:13,pendingPage:1});f.render();for(let i=0;i<11;i++){f.button('Next pending trade').props.onClick();f.render();}assert.deepEqual(f.pages,[]);f.button('Next pending trade').props.onClick();assert.deepEqual(f.pages,[2]);
});
