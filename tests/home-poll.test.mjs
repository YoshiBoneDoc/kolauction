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
 export { PollManager } from './src/pages/AdminPolls.jsx';
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
 ...React,useState:state,useRef:initial=>state({current:initial})[0],useEffect:fn=>active.effects.push(fn),useContext:()=>({currentUser:user}),
}:require(name),compiled,compiled.exports);
const {HomePoll,PollPanel,PollManager}=compiled.exports;
function nodes(tree) {
 if(!tree || typeof tree!=='object')return [];
 return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
function harness(service,component=PollPanel) {
 const h={slots:[],render(){active=h;h.cursor=0;h.effects=[];h.tree=component({service});return h;},
  async load(){h.effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));h.render();},
  button(label){return nodes(h.tree).find(n=>n.type==='button'&&(n.props['aria-label']||n.props.children)===label);},
  html(){return h.tree?renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},h.tree)):'';}};
 return h.render();
}
const poll={id:'poll',question:'Should sellers have the option to end auctions early if they’re happy with the current bid?',active:true,has_voted:false,can_manage:false};

const feed = poll => ({poll,published_results:[],can_manage:poll?.can_manage || false});

test('poll service passes only the authenticated RPC arguments and surfaces failures',async()=>{
 const calls=[];
 const service=createPollService({async rpc(name,args){calls.push([name,args]);return {data:poll,error:null};}});
 assert.deepEqual(await service.read(),poll);await service.vote('poll',false);await service.close('poll');await service.voters('poll');
 assert.deepEqual(calls,[['read_home_poll_feed',undefined],['vote_home_poll',{p_poll_id:'poll',p_answer:false}],['close_home_poll',{p_poll_id:'poll'}],['read_poll_voters',{p_poll_id:'poll'}]]);
 await assert.rejects(createPollService(null).read(),/temporarily unavailable/);
 await assert.rejects(createPollService({rpc:async()=>({error:{message:'This poll is closed.'}})}).vote('poll',true),/closed/);
});

test('homepage poll stays hidden for guests/restricted accounts and remounts per account',()=>{
 user=null;assert.equal(HomePoll(),null);
 user={id:'restricted',isBanned:true};assert.equal(HomePoll(),null);
 user={id:'first'};assert.equal(HomePoll().key,'first');
 user={id:'second'};assert.equal(HomePoll().key,'second');
});

test('Yes and No save once and replace voting with a compact live-results box',async()=>{
 for(const answer of [true,false]){
  const votes=[];let saved=false;const h=harness({read:async()=>feed(saved?{...poll,has_voted:true,results:{yes:answer?1:0,no:answer?0:1,total:1}}:poll),vote:async(...args)=>{votes.push(args);saved=true;}});
  await h.load();assert.match(h.html(),/bg-yellow-100/);assert.match(h.html(),/current bid/);
  assert.doesNotMatch(h.html(),/Admin results|Conclude poll|Refresh results/);
  await h.button(answer?'Yes':'No').props.onClick();h.render();
  assert.deepEqual(votes,[['poll',answer]]);assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/bg-yellow-50/);assert.match(h.html(),/Live poll results/);assert.match(h.html(),/100%/);assert.doesNotMatch(h.html(),/View voters/);
 }
 const voted=harness({read:async()=>feed(null)});await voted.load();assert.equal(voted.tree,null);
});

test('failed votes retain choices and offer retry instead of claiming a vote was saved',async()=>{
 const h=harness({read:async()=>feed(poll),vote:async()=>{throw new Error('Try again later.');}});
 await h.load();await h.button('Yes').props.onClick();h.render();
 assert.match(h.html(),/role="alert"/);assert.match(h.html(),/Try again later/);assert.ok(h.button('No'));assert.ok(h.button('Retry'));
});

test('homepage administrators see all live results without voting and can conclude each poll',async()=>{
 let results=[{...poll,can_manage:true,results:{yes:1,no:1,total:2}}, {...poll,id:'second',question:'Another active poll?',can_manage:true,results:{yes:0,no:0,total:0}}];
 let votes=0;const closed=[];
 const h=harness({read:async()=>({poll:null,can_manage:true,answered_polls:results,published_results:[{id:'past',question:'Archived admin summary?',has_voted:false,results:{yes:3,no:0,total:3}}]}),vote:async()=>{votes++;},close:async(id)=>{closed.push(id);results=results.filter(p=>p.id!==id);}});
 await h.load();assert.equal(h.button('Yes'),undefined);assert.equal(h.button('No'),undefined);
 assert.match(h.html(),/50%/);assert.doesNotMatch(h.html(),/Another active poll|Archived admin summary/);
 h.button('Next poll results').props.onClick();h.render();assert.match(h.html(),/Another active poll/);assert.match(h.html(),/0 votes/);
 h.button('Next poll results').props.onClick();h.render();assert.match(h.html(),/Archived admin summary/);
 h.button('Next poll results').props.onClick();h.render();assert.match(h.html(),/Admin results|View voters/);
 await h.button('Conclude poll').props.onClick();h.render();assert.deepEqual(closed,['poll']);assert.doesNotMatch(h.html(),/current bid/);assert.match(h.html(),/Another active poll/);assert.equal(votes,0);
});

test('an older admin feed never restores the Yes or No voting buttons',async()=>{
 const h=harness({read:async()=>feed({...poll,can_manage:true,results:{yes:1,no:1,total:2}})});
 await h.load();assert.equal(h.button('Yes'),undefined);assert.equal(h.button('No'),undefined);assert.match(h.html(),/50%/);
});


test('published past results share a results panel with answered live polls',async()=>{
 let saved=false;
 const previous={id:'previous',has_voted:true,question:'Our earlier question?',results:{yes:3,no:1,total:4}};
 const h=harness({read:async()=>({...feed(saved?{...poll,has_voted:true,results:{yes:0,no:1,total:1}}:poll),published_results:[previous]}),vote:async()=>{saved=true;}});
 await h.load();assert.match(h.html(),/Our earlier question/);assert.match(h.html(),/75%/);
 await h.button('No').props.onClick();h.render();assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/Next poll results/);
 h.button('Next poll results').props.onClick();h.render();assert.match(h.html(),/Our earlier question/);
 assert.doesNotMatch(h.html(),/Admin results|Manage polls/);
});


test('an old background response cannot restore voting after a successful submission',async()=>{
 let reads=0,release;
 const h=harness({read:async()=>{reads++;if(reads===2)return new Promise(resolve=>{release=resolve;});return feed(reads>2?{...poll,has_voted:true,results:{yes:1,no:0,total:1}}:poll);},vote:async()=>{}});
 await h.load();h.effects[0]();
 await h.button('Yes').props.onClick();h.render();
 release(feed(poll));await new Promise(resolve=>setImmediate(resolve));h.render();
 assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/Live poll results/);
});

test('a failed post-vote results refresh keeps voting disabled and offers retry',async()=>{
 let saved=false;
 const h=harness({read:async()=>{if(saved)throw new Error('Connection lost.');return feed(poll);},vote:async()=>{saved=true;}});
 await h.load();await h.button('Yes').props.onClick();h.render();
 assert.equal(h.button('Yes'),undefined);assert.match(h.html(),/Results unavailable/);assert.ok(h.button('Retry'));
});


test('multiple live polls advance one question at a time while answered results share one navigable panel',async()=>{
 const polls=[poll,{...poll,id:'second',question:'Should we add a second feature?'},{...poll,id:'third',question:'Should we add a third feature?'}];
 const answered=new Set();const calls=[];
 const service={read:async()=>({poll:polls.find(p=>!answered.has(p.id))||null,answered_polls:polls.filter(p=>answered.has(p.id)).map(p=>({...p,has_voted:true,results:{yes:1,no:0,total:1}})),published_results:[],can_manage:false}),vote:async(id)=>{calls.push(id);answered.add(id);}};
 const h=harness(service);await h.load();assert.match(h.html(),/current bid/);assert.doesNotMatch(h.html(),/second feature|third feature|Live poll results/);
 await h.button('Yes').props.onClick();h.render();assert.match(h.html(),/second feature/);assert.match(h.html(),/Live poll results/);assert.doesNotMatch(h.html(),/third feature/);
 await h.button('No').props.onClick();h.render();assert.match(h.html(),/third feature/);assert.equal((h.html().match(/<article/g)||[]).length,1);
 await h.button('Yes').props.onClick();h.render();assert.equal(h.button('Yes'),undefined);assert.equal((h.html().match(/<article/g)||[]).length,1);assert.match(h.html(),/1 \/ 3/);
 h.button('Previous poll results').props.onClick();h.render();assert.match(h.html(),/Results: Should we add a third feature/);
 h.button('Next poll results').props.onClick();h.render();assert.match(h.html(),/Results: Should sellers/);
 assert.deepEqual(calls,['poll','second','third']);
});

test('homepage hides unvoted live and archived result records even if supplied by a stale feed',async()=>{
 const h=harness({read:async()=>({poll,answered_polls:[{...poll,results:{yes:99,no:0,total:99}}],published_results:[{id:'unvoted',question:'Do not show this summary?',results:{yes:99,no:0,total:99}}]})});
 await h.load();assert.doesNotMatch(h.html(),/99|Do not show|Live poll results/);assert.ok(h.button('Yes'));
});


test('admin manager publishes an additional poll without concluding existing live polls',async()=>{
 let records=[{id:'one',question:'First live question?',active:true,published_at:'2026-10-22T12:00:00Z',results:{yes:0,no:0,total:0}},{id:'two',question:'Second live question?',active:true,published_at:'2026-10-22T12:01:00Z',results:{yes:0,no:0,total:0}},{id:'draft',question:'A third live question?',active:false,published_at:null}];
 const published=[];const service={list:async()=>records,publish:async(...args)=>{published.push(args);records=records.map(p=>p.id==='draft'?{...p,active:true,published_at:'2026-10-22T12:02:00Z',results:{yes:0,no:0,total:0}}:p);}};
 const h=harness(service,PollManager);await h.load();assert.ok(h.button('Publish poll'));assert.doesNotMatch(h.html(),/Conclude current/);
 await h.button('Publish poll').props.onClick();h.render();assert.deepEqual(published,[['draft']]);assert.equal(records.filter(p=>p.active).length,3);
});
