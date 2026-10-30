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
 if (!(index in h.slots)) h.slots[index]=typeof initial==='function'?initial():initial;
 return [h.slots[index],next=>{h.slots[index]=typeof next==='function'?next(h.slots[index]):next;}];
}
const compiled={exports:{}};
const require=createRequire(import.meta.url);
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react'?{
 ...React,useState:state,useId:()=>state('test-poll-results')[0],useRef:initial=>state({current:initial})[0],useEffect:fn=>active.effects.push(fn),useContext:()=>({currentUser:user}),
}:name==='react-dom'?{...require(name),createPortal:(panel,target)=>React.cloneElement(panel,{'data-placement':target.name})}:require(name),compiled,compiled.exports);
const {HomePoll,PollPanel,PollManager}=compiled.exports;
function nodes(tree) {
 if(!tree || typeof tree!=='object')return [];
 return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
function harness(service,component=PollPanel,props={}) {
 const h={slots:[],render(){active=h;h.cursor=0;h.effects=[];h.tree=component({service,...props});return h;},
  async load(){h.effects.forEach(fn=>fn());await new Promise(resolve=>setImmediate(resolve));h.render();},
  button(label){return nodes(h.tree).find(n=>n.type==='button'&&(n.props['aria-label']||n.props.children)===label);},
  html(){return h.tree?renderToStaticMarkup(React.createElement(StaticRouter,{location:'/'},h.tree)):'';}};
 return h.render();
}
const poll={id:'poll',question:'Should sellers have the option to end auctions early if they’re happy with the current bid?',active:true,has_voted:false,can_manage:false};

const feed = poll => ({poll,published_results:[],can_manage:poll?.can_manage || false});

test('deleting a poll requires explicit confirmation and removes it only after the server succeeds',async()=>{
 const previousWindow=globalThis.window;
 try {
  let records=[{...poll,results:{yes:1,no:0,total:1},published_at:'2026-10-24T12:00:00Z'}];
  const calls=[];let accept=false;let fail=false;const prompts=[];
  globalThis.window={confirm:message=>{prompts.push(message);return accept;}};
  const service={list:async()=>records,remove:async id=>{calls.push(id);if(fail)throw Error('Delete failed.');records=[];}};
  const h=harness(service,PollManager);await h.load();
  await h.button('Delete poll').props.onClick();h.render();assert.deepEqual(calls,[]);assert.match(h.html(),/current bid/);
  assert.match(prompts[0],/permanently delete/);assert.match(prompts[0],/cannot be recovered/);assert.match(prompts[0],/This poll is live/);
  accept=true;fail=true;await h.button('Delete poll').props.onClick();h.render();assert.match(h.html(),/Delete failed/);assert.ok(h.button('Delete poll'));
  fail=false;await h.button('Delete poll').props.onClick();h.render();assert.equal(h.button('Delete poll'),undefined);
  assert.deepEqual(calls,['poll','poll']);
 } finally {if(previousWindow===undefined)delete globalThis.window;else globalThis.window=previousWindow;}
});

test('unanswered polls feature above auctions and keep results there until leaving the homepage',async()=>{
 let saved=false;
 const service={read:async()=>feed(saved?{...poll,has_voted:true,results:{yes:1,no:0,total:1}}:poll),vote:async()=>{saved=true;}};
 const props={featuredTarget:{current:{name:'top'}}};
 const visit=harness(service,PollPanel,props);await visit.load();assert.equal(visit.tree.props['data-placement'],'top');
 await visit.button('Yes').props.onClick();visit.render();assert.equal(visit.tree.props['data-placement'],'top');assert.match(visit.html(),/Live poll results/);
 await visit.load();assert.equal(visit.tree.props['data-placement'],'top');
 const returned=harness(service,PollPanel,props);await returned.load();assert.equal(returned.tree.props['data-placement'],undefined);assert.match(returned.html(),/Live poll results/);
});

test('skipped text polls stay featured this visit but return minimized at the bottom on a later visit',async()=>{
 let skipped=false;const textPoll={...poll,poll_type:'free_text'};
 const service={read:async()=>({...feed(skipped?null:textPoll),skipped_polls:skipped?[textPoll]:[]}),skip:async()=>{skipped=true;}};
 const props={featuredTarget:{current:{name:'top'}}};
 const visit=harness(service,PollPanel,props);await visit.load();await visit.button('Skip').props.onClick();visit.render();
 assert.equal(visit.tree.props['data-placement'],'top');assert.match(visit.html(),/Answer this poll/);
 const returned=harness(service,PollPanel,props);await returned.load();assert.equal(returned.tree.props['data-placement'],undefined);assert.match(returned.html(),/Answer this poll/);
});

test('remaining unanswered questions feature on return; admin results stay at the bottom',async()=>{
 const props={featuredTarget:{current:{name:'top'}}};
 const visit=harness({read:async()=>({...feed(poll),answered_polls:[{...poll,id:'older',has_voted:true,results:{yes:1,no:0,total:1}}]})},PollPanel,props);
 await visit.load();assert.equal(visit.tree.props['data-placement'],'top');assert.ok(visit.button('Yes'));
 const admin=harness({read:async()=>feed({...poll,can_manage:true,results:{yes:1,no:0,total:1}})},PollPanel,props);
 await admin.load();assert.equal(admin.tree.props['data-placement'],undefined);assert.equal(admin.button('Yes'),undefined);
});

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
 await h.load();h.effects.at(-1)();
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

test('free-text poll collapses after submission and reopens for optional additional private responses',async()=>{
 const textPoll={...poll,id:'text',question:'What would you like us to improve?',poll_type:'free_text',allow_multiple_responses:true};
 let answered=false;const calls=[];
 const service={read:async()=>({poll:answered?null:textPoll,answered_polls:[],published_results:[],repeatable_polls:answered?[textPoll]:[]}),respond:async(...args)=>{calls.push(args);answered=true;}};
 const h=harness(service);await h.load();assert.equal(h.button('Yes'),undefined);assert.equal(h.button('No'),undefined);
 const textarea=()=>nodes(h.tree).find(n=>n.type==='textarea');
 textarea().props.onChange({target:{value:'A suggestion'}});h.render();
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();
 assert.equal(calls[0][0],'text');assert.equal(calls[0][1],'A suggestion');assert.match(calls[0][2],/^[a-f0-9-]{36}$/);
 assert.equal(textarea(),undefined);assert.match(h.html(),/sent privately/);assert.doesNotMatch(h.html(),/Yes:|No:|View voters/);
 h.button('Send another response: '+textPoll.question).props.onClick();h.render();assert.ok(textarea());
 textarea().props.onChange({target:{value:'Another suggestion'}});h.render();
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();
 assert.equal(calls.length,2);assert.notEqual(calls[0][2],calls[1][2]);assert.equal(textarea(),undefined);
});

test('uncertain free-text writes retain the draft and request ID across retries, while double submissions are blocked',async()=>{
 const textPoll={...poll,poll_type:'free_text',allow_multiple_responses:true};const calls=[];let finish;let fail=true;
 const service={read:async()=>feed(textPoll),respond:(...args)=>{calls.push(args);return new Promise((resolve,reject)=>{finish=()=>fail?reject(Error('Network interrupted.')):resolve();});}};
 const h=harness(service);await h.load();
 nodes(h.tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Keep my suggestion'}});h.render();
 const form=()=>nodes(h.tree).find(n=>n.type==='form');
 const first=form().props.onSubmit({preventDefault(){}});await form().props.onSubmit({preventDefault(){}});assert.equal(calls.length,1);
 finish();await first;h.render();assert.match(h.html(),/Network interrupted/);assert.match(h.html(),/Keep my suggestion/);
 fail=false;const second=form().props.onSubmit({preventDefault(){}});finish();await second;h.render();
 assert.equal(calls[0][2],calls[1][2]);
});

test('poll manager saves the free-text type and multiple-response setting and does not offer public text results',async()=>{
 const calls=[];const service={list:async()=>[],saveDraft:async(...args)=>calls.push(args)};
 const h=harness(service,PollManager);await h.load();
 const find=type=>nodes(h.tree).find(n=>n.type===type);
 find('select').props.onChange({target:{value:'free_text'}});h.render();
 nodes(h.tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});h.render();
 find('textarea').props.onChange({target:{value:'What would you like to suggest?'}});h.render();
 await find('form').props.onSubmit({preventDefault(){}});h.render();
 assert.deepEqual(calls,[['What would you like to suggest?',null,'free_text',true,[]]]);
 const closed=harness({list:async()=>[{id:'private',question:'A private text question?',poll_type:'free_text',allow_multiple_responses:true,published_at:'2026-10-23T12:00:00Z',closed_at:'2026-10-23T13:00:00Z',results:{total:4}}]},PollManager);
 await closed.load();assert.match(closed.html(),/4 responses/);assert.match(closed.html(),/category=other/);
 assert.equal(closed.button('Publish results on homepage'),undefined);assert.doesNotMatch(closed.html(),/Yes:|No:|View voters/);
});

test('text poll service sends only the poll, response, retry ID and admin draft settings',async()=>{
 const calls=[];const service=createPollService({rpc:async(...args)=>{calls.push(args);return{data:null};}});
 await service.respond('poll','Suggestion','request');await service.saveDraft('Question goes here',null,'free_text',true);
 assert.deepEqual(calls,[['respond_to_home_poll',{p_poll_id:'poll',p_response:'Suggestion',p_request_id:'request'}],['save_poll_draft',{p_question:'Question goes here',p_poll_id:null,p_poll_type:'free_text',p_allow_multiple:true,p_choices:[]}]]);
});

test('Skip advances a text poll without submitting a response and prevents duplicate requests',async()=>{
 const textPoll={...poll,poll_type:'free_text'};const calls=[];let finish;let skipped=false;
 const service={read:async()=>feed(skipped?{...poll,id:'next',question:'The next question?'}:textPoll),skip:id=>{calls.push(id);return new Promise(resolve=>{finish=()=>{skipped=true;resolve();};});},respond:()=>assert.fail('Skip must not submit a response')};
 const h=harness(service);await h.load();assert.ok(h.button('Skip'));
 const first=h.button('Skip').props.onClick();await h.button('Skip').props.onClick();assert.deepEqual(calls,['poll']);
 finish();await first;h.render();assert.match(h.html(),/The next question/);assert.match(h.html(),/No response was submitted/);assert.equal(h.button('Skip'),undefined);
});

test('failed Skip keeps the question and draft available for retry',async()=>{
 const h=harness({read:async()=>feed({...poll,poll_type:'free_text'}),skip:async()=>{throw Error('Skip unavailable');}});await h.load();
 nodes(h.tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Keep this draft'}});h.render();
 await h.button('Skip').props.onClick();h.render();assert.match(h.html(),/Skip unavailable/);assert.match(h.html(),/Keep this draft/);assert.ok(h.button('Skip'));
});

test('multiple-choice selection submits once and reveals results only after answering',async()=>{
 const item={...poll,poll_type:'multiple_choice',choices:['First option','Second option']};let answered=false;const calls=[];
 const service={read:async()=>({poll:answered?null:item,answered_polls:answered?[{...item,has_voted:true,results:{total:2,choices:[{index:1,label:'First option',count:0},{index:2,label:'Second option',count:2}]}}]:[]}),voteChoice:async(...args)=>{calls.push(args);answered=true;}};
 const h=harness(service);await h.load();assert.equal(h.button('Yes'),undefined);assert.ok(h.button('Submit vote').props.disabled);assert.doesNotMatch(h.html(),/100%/);
 nodes(h.tree).filter(n=>n.type==='input'&&n.props.type==='radio')[1].props.onChange();h.render();assert.deepEqual(calls,[]);assert.equal(h.button('Submit vote').props.disabled,false);
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});h.render();assert.deepEqual(calls,[['poll',2]]);assert.match(h.html(),/100%/);assert.equal(h.button('Submit vote'),undefined);
});

test('admin manager validates and saves multiple-choice options',async()=>{
 const calls=[];const h=harness({list:async()=>[],saveDraft:async(...args)=>calls.push(args)},PollManager);await h.load();
 const byId=id=>nodes(h.tree).find(n=>n.props.id===id);
 byId('poll-type').props.onChange({target:{value:'multiple_choice'}});h.render();
 byId('poll-question').props.onChange({target:{value:'Which feature should we add?'}});byId('poll-choices').props.onChange({target:{value:'Duplicate\nduplicate'}});h.render();assert.ok(h.button('Save draft').props.disabled);
 byId('poll-choices').props.onChange({target:{value:' First \n Second '}});h.render();assert.equal(h.button('Save draft').props.disabled,false);
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});assert.deepEqual(calls,[['Which feature should we add?',null,'multiple_choice',false,['First','Second']]]);
});

test('choice and Skip service calls use only the target poll and chosen option',async()=>{
 const calls=[];const service=createPollService({rpc:async(...args)=>{calls.push(args);return{data:null};}});
 await service.voteChoice('one',2);await service.skip('text');
 await service.remove('old-poll');
 assert.deepEqual(calls,[['vote_home_poll_choice',{p_poll_id:'one',p_choice:2}],['skip_home_poll',{p_poll_id:'text'}],['delete_home_poll',{p_poll_id:'old-poll'}]]);
});

test('skipped text questions stay minimized below results and can be answered without blocking the next poll',async()=>{
 const skipped={...poll,id:'skipped',question:'Any suggestions for us?',poll_type:'free_text',allow_multiple_responses:false,has_voted:false};
 const next={...poll,id:'next',poll_type:'multiple_choice',choices:['One','Two']};let submitted=false;const calls=[];
 const h=harness({read:async()=>({poll:next,skipped_polls:submitted?[]:[skipped],answered_polls:[{...poll,id:'old',has_voted:true,results:{yes:1,no:0,total:1}}]}),respond:async(...args)=>{calls.push(args);submitted=true;}});
 await h.load();assert.equal(h.button('Skip'),undefined);assert.ok(h.button('Submit vote'));assert.ok(h.button('Answer this poll: '+skipped.question));
 assert.ok(h.html().indexOf('Answer this poll')>h.html().indexOf('Live poll results'));
 h.button('Answer this poll: '+skipped.question).props.onClick();h.render();assert.equal(h.button('Skip'),undefined);
 nodes(h.tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Changed my mind'}});h.render();
 await nodes(h.tree).find(n=>n.type==='form'&&nodes(n).some(child=>child.type==='textarea')).props.onSubmit({preventDefault(){}});h.render();
 assert.equal(calls[0][0],'skipped');assert.equal(calls[0][1],'Changed my mind');assert.ok(h.button('Submit vote'));assert.equal(h.button('Answer this poll: '+skipped.question),undefined);
});

test('multi-select checkboxes submit one ballot and disable empty selections',async()=>{
 const item={...poll,poll_type:'multiple_choice',allow_multiple_responses:true,choices:['Search','Filters','Alerts']};const calls=[];
 const h=harness({read:async()=>feed(item),voteChoices:async(...args)=>calls.push(args)});await h.load();
 const boxes=()=>nodes(h.tree).filter(n=>n.type==='input'&&n.props.type==='checkbox');
 assert.equal(boxes().length,3);assert.ok(h.button('Submit vote').props.disabled);
 boxes()[0].props.onChange();h.render();boxes()[2].props.onChange();h.render();
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(calls,[['poll',[1,3]]]);h.render();
 boxes()[0].props.onChange();h.render();boxes()[2].props.onChange();h.render();assert.ok(h.button('Submit vote').props.disabled);
});

test('admin can enable several answers on a multiple-choice draft',async()=>{
 const calls=[];const h=harness({list:async()=>[],saveDraft:async(...args)=>calls.push(args)},PollManager);await h.load();
 const byId=id=>nodes(h.tree).find(n=>n.props.id===id);
 byId('poll-type').props.onChange({target:{value:'multiple_choice'}});h.render();
 byId('poll-question').props.onChange({target:{value:'Which features should we add?'}});
 byId('poll-choices').props.onChange({target:{value:'Search\nFilters'}});
 nodes(h.tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});h.render();
 await nodes(h.tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
 assert.deepEqual(calls,[['Which features should we add?',null,'multiple_choice',true,['Search','Filters']]]);
});
