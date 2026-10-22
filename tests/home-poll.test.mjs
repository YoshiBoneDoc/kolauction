import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { StaticRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPollService } from '../src/lib/polls.js';

const { outputFiles } = buildSync({ stdin: { contents: `
 export { default as HomePoll, PollPanel } from './src/components/HomePoll.jsx';
`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' }, bundle: true, write: false,
 platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' } });
let active, user;
function state(initial) {
 const h=active,index=h.cursor++;
 if (!(index in h.slots)) h.slots[index]=initial;
 return [h.slots[index],next=>{h.slots[index]=typeof next==='function'?next(h.slots[index]):next;}];
}
const compiled={exports:{}};
const require=createRequire(import.meta.url);
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{
 ...React,useState:state,useEffect:fn=>active.effects.push(fn),useContext:()=>({currentUser:user}),
}:require(name),compiled,compiled.exports);
const {HomePoll,PollPanel}=compiled.exports;
function nodes(tree) {
 if(!tree || typeof tree!=='object')return [];
 return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
function harness(service) {
 const h={slots:[],render(){active=h;h.cursor=0;h.effects=[];h.tree=PollPanel({service});return h;},
  async load(){h.effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));h.render();},
  button(label){return nodes(h.tree).find(n=>n.type==='button'&&n.props.children===label);},
  html(){return h.tree?renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},h.tree)):'';}};
 return h.render();
}
const poll={id:'poll',question:'Should sellers have the option to end auctions early if they’re happy with the current bid?',active:true,has_voted:false,can_manage:false};

const feed = poll => ({poll,published_results:[],can_manage:poll?.can_manage || false});

test('poll service passes only the authenticated RPC arguments and surfaces failures',async()=>{
 const calls=[];
 const service=createPollService({async rpc(name,args){calls.push([name,args]);return {data:poll,error:null};}});
 assert.deepEqual(await service.read(),poll);await service.vote('poll',false);await service.close('poll');
 assert.deepEqual(calls,[['read_home_poll_feed',undefined],['vote_home_poll',{p_poll_id:'poll',p_answer:false}],['close_home_poll',{p_poll_id:'poll'}]]);
 await assert.rejects(createPollService(null).read(),/temporarily unavailable/);
 await assert.rejects(createPollService({rpc:async()=>({error:{message:'This poll is closed.'}})}).vote('poll',true),/closed/);
});

test('homepage poll stays hidden for guests/restricted accounts and remounts per account',()=>{
 user=null;assert.equal(HomePoll(),null);
 user={id:'restricted',isBanned:true};assert.equal(HomePoll(),null);
 user={id:'first'};assert.equal(HomePoll().key,'first');
 user={id:'second'};assert.equal(HomePoll().key,'second');
});

test('Yes and No each save the chosen boolean and hide the banner after success',async()=>{
 for(const answer of [true,false]){
  const votes=[];const h=harness({read:async()=>feed(poll),vote:async(...args)=>votes.push(args)});
  await h.load();assert.match(h.html(),/bg-yellow-100/);assert.match(h.html(),/current bid/);
  assert.doesNotMatch(h.html(),/Admin results|Conclude poll|Refresh results/);
  await h.button(answer?'Yes':'No').props.onClick();h.render();
  assert.deepEqual(votes,[['poll',answer]]);assert.equal(h.tree,null);
 }
 const voted=harness({read:async()=>feed(null)});await voted.load();assert.equal(voted.tree,null);
});

test('failed votes retain choices and offer retry instead of claiming a vote was saved',async()=>{
 const h=harness({read:async()=>feed(poll),vote:async()=>{throw new Error('Try again later.');}});
 await h.load();await h.button('Yes').props.onClick();h.render();
 assert.match(h.html(),/role="alert"/);assert.match(h.html(),/Try again later/);assert.ok(h.button('No'));assert.ok(h.button('Retry'));
});

test('administrator can see totals/percentages, refresh results, vote once and close the poll',async()=>{
 let current={...poll,can_manage:true,results:{yes:1,no:1,total:2}},closed=false;
 const h=harness({read:async()=>feed(current),vote:async()=>{current={...current,has_voted:true,results:{yes:2,no:1,total:3}};},close:async()=>{closed=true;current={...current,active:false};}});
 await h.load();assert.match(h.html(),/Admin results/);assert.match(h.html(),/50%/);assert.ok(h.button('Refresh results'));
 await h.button('Yes').props.onClick();h.render();assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/67%/);
 await h.button('Conclude poll').props.onClick();h.render();assert.equal(closed,true);assert.match(h.html(),/Closed/);assert.match(h.html(),/Admin results/);assert.equal(h.button('Conclude poll'),undefined);
});


test('published past results remain visible beside a new poll and after the user votes',async()=>{
 const previous={id:'previous',question:'Our earlier question?',results:{yes:3,no:1,total:4}};
 const h=harness({read:async()=>({...feed(poll),published_results:[previous]}),vote:async()=>{}});
 await h.load();assert.match(h.html(),/Our earlier question/);assert.match(h.html(),/75%/);
 await h.button('No').props.onClick();h.render();assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/Previous poll results/);
 assert.doesNotMatch(h.html(),/Admin results|Manage polls/);
});
