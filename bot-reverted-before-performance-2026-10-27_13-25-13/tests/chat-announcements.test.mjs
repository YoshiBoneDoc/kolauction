import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatAnnouncer, CHAT_INTERVAL, readChatState, saveChatState } from '../src/chat-announcements.mjs';
import { CHAT_MESSAGES } from '../src/chat-messages.mjs';
import { KolTransport } from '../src/transport.mjs';

function fixture() {
    let time=1000000,state=null;
    const calls=[],logs=[];
    const options={now:()=>time,read:()=>structuredClone(state),save:value=>{state=structuredClone(value);},
        transport:{postChatAnnouncement:async(...args)=>{calls.push(args);return 'confirmed';}},log:line=>logs.push(line)};
    return {options,calls,logs,clock:ms=>{time+=ms;},state:()=>state,create:()=>createChatAnnouncer(options)};
}
test('announcements rotate six hours apart and their schedule survives process/container restarts',async()=>{
    const f=fixture();let chat=f.create();await chat.tick();assert.equal(f.calls[0][1],CHAT_MESSAGES[0]);
    assert.equal(f.state().outcome,'confirmed');chat=f.create();await chat.tick();assert.equal(f.calls.length,1);
    assert.equal(CHAT_INTERVAL,6*60*60*1000);
    f.clock(6*60*60*1000-1);await chat.tick();assert.equal(f.calls.length,1);
    f.clock(1);await chat.tick();assert.equal(f.calls[1][1],CHAT_MESSAGES[1]);
    for(let index=2;index<=CHAT_MESSAGES.length;index++) {
        f.clock(CHAT_INTERVAL);await f.create().tick();assert.equal(f.calls[index][1],CHAT_MESSAGES[index % CHAT_MESSAGES.length]);
    }
});
test('a saved reservation or uncertain send is never immediately retried after restart',async()=>{
    for(const outcome of ['unconfirmed','throw']) {
        const f=fixture();f.options.transport.postChatAnnouncement=async()=>{f.calls.push('send');if(outcome==='throw')throw Error('secret session detail');return outcome;};
        await f.create().tick();await f.create().tick();assert.equal(f.calls.length,1);assert.equal(f.state().outcome,'unconfirmed');assert.ok(f.logs.every(line=>!line.includes('secret')));
    }
    const f=fixture();const controller=new AbortController();f.options.signal=controller.signal;
    const save=f.options.save;f.options.save=value=>{save(value);controller.abort();};
    await f.create().tick();assert.equal(f.state().outcome,'reserved');assert.equal(f.calls.length,0);
    delete f.options.signal;await f.create().tick();assert.equal(f.calls.length,0);
});
test('only one tick can reserve or send while another tick is pending',async()=>{
    const f=fixture();let finish;f.options.transport.postChatAnnouncement=()=>new Promise(resolve=>{finish=resolve;f.calls.push('send');});
    const chat=f.create();const first=chat.tick();await chat.tick();assert.equal(f.calls.length,1);finish('confirmed');await first;
});
test('rollover, disabled announcements and shutdown do not consume a slot or send',async()=>{
    for(const setup of [f=>{f.options.enabled=false;},f=>{f.options.transport.transfersAllowed=()=>false;},f=>{const c=new AbortController();c.abort();f.options.signal=c.signal;}]) {
        const f=fixture();setup(f);await f.create().tick();assert.equal(f.calls.length,0);assert.equal(f.state(),null);
    }
});
test('invalid config, corrupt state and filesystem failures cannot stop auction work or allow an unreserved post',async()=>{
    for(const setup of [f=>{f.options.channel='trade && /w bad';},f=>{f.options.messages=['/w bad hi'];},f=>{f.options.read=()=>({version:0});},f=>{f.options.read=()=>{throw Error('secret');};},f=>{f.options.save=()=>{throw Error('secret');};}]) {
        const f=fixture();setup(f);await f.create().tick();assert.equal(f.calls.length,0);assert.ok(f.logs.length);assert.ok(f.logs.every(line=>!line.includes('secret')));
    }
});
test('state is saved before channel entry and failed final writes still prevent a resend',async()=>{
    const f=fixture();let saves=0;const save=f.options.save;
    f.options.save=value=>{if(++saves===2)throw Error('Disk unavailable');save(value);};
    f.options.transport.postChatAnnouncement=async()=>{assert.equal(f.state().outcome,'reserved');f.calls.push('send');return 'confirmed';};
    await f.create().tick();await f.create().tick();assert.equal(f.calls.length,1);
});
test('real state files persist the cursor and reject corruption instead of resetting the cooldown',()=>{
    const dir=mkdtempSync(join(tmpdir(),'khub-chat-test-'));const path=join(dir,'chat.json');
    try {
        assert.equal(readChatState(path),null);const state={version:1,nextAt:12345,nextIndex:1};saveChatState(state,path);assert.deepEqual(readChatState(path),state);
        writeFileSync(path,'null');assert.throws(()=>readChatState(path));writeFileSync(path,'{bad');assert.throws(()=>readChatState(path));
    } finally {rmSync(dir,{recursive:true,force:true});}
});
function transportFixture(handler) {
    const calls=[];const session=()=>{};session.raw=async(path,options)=>{calls.push({path,options});return handler(calls.length,options);};
    const transport=new KolTransport('kHub','',{session});transport.identity=async()=>{};
    return {transport,calls};
}
test('chat uses the existing session, selects the channel and sends once with explicit routing and no retries',async()=>{
    const message=CHAT_MESSAGES[0];
    const f=transportFixture(n=>({status:200,_data:{msgs:n===2?[{type:'public',who:{id:'3888760'},channel:'trade',msg:message}]:[]}}));
    assert.equal(await f.transport.postChatAnnouncement('trade',message),'confirmed');assert.equal(f.calls.length,2);
    assert.deepEqual(f.calls.map(c=>c.options.query.graf),['/channel trade','/trade '+message]);
    for(const {path,options} of f.calls){assert.equal(path,'submitnewchat.php');assert.equal(options.retry,0);assert.equal(options.redirect,'manual');assert.equal(options.timeout,5000);}
});
test('chat timeouts/redirects get no retry, other-player echoes cannot confirm a post, and stop prevents posting after entry',async()=>{
    const timeout=transportFixture(()=>{throw Error('Timeout');});await assert.rejects(timeout.transport.postChatAnnouncement('trade',CHAT_MESSAGES[0]));assert.equal(timeout.calls.length,1);
    const redirect=transportFixture(()=>({status:302}));assert.equal(await redirect.transport.postChatAnnouncement('trade',CHAT_MESSAGES[0]),'unconfirmed');assert.equal(redirect.calls.length,1);
    const other=transportFixture(()=>({status:200,_data:{msgs:[{type:'public',who:{id:'1'},channel:'trade',msg:CHAT_MESSAGES[0]}]}}));assert.equal(await other.transport.postChatAnnouncement('trade',CHAT_MESSAGES[0]),'unconfirmed');
    let stopped=false;const f=transportFixture(()=>{stopped=true;return{status:200,_data:{msgs:[]}};});await f.transport.postChatAnnouncement('trade',CHAT_MESSAGES[0],{shouldStop:()=>stopped});assert.equal(f.calls.length,1);
});


import { runWorker } from '../src/runtime.mjs';
test('runtime posts only after healthy auction work; chat failures never stop the worker and read-only/blocked modes never post',async()=>{
    for(const mode of ['healthy','blocked','read-only']) {
        const controller=new AbortController();const calls=[];let factories=0;
        const transport={postChatAnnouncement:async()=>{},connect:async()=>{},inbox:async()=>[],snapshot:async()=>({meat:100,items:{}}),closetSnapshot:async()=>({meat:100,closetMeat:0,items:{},closetItems:{}})};
        const store={rpc:async(name)=>{
            calls.push(name);
            if(name==='bot_item_catalog_state')return{fetched_at:new Date(Date.now()+86400000).toISOString()};
            if(name==='bot_inspect')return{attention:[],closetAttention:mode==='blocked'?[{id:'unknown'}]:[]};
            if(name==='bot_liabilities')return{meat:0,items:{}};
            return null;
        }};
        await runWorker({store,transport,live:mode!=='read-only',poll:15,reserve:0,signal:controller.signal,log:()=>{},
            createAnnouncer:()=>{factories++;return{tick:async()=>{calls.push('chat');throw Error('Chat failure');}};},
            report:event=>{if(event.type==='cycle')controller.abort();},
        });
        assert.equal(calls.includes('chat'),mode==='healthy');
        if(mode==='healthy')assert.ok(calls.indexOf('chat')>calls.indexOf('bot_claim_closet_transfer'));
        if(mode==='read-only')assert.equal(factories,0);
    }
});


test('upgrading two-hour and legacy four-hour schedules waits six hours without resetting message order',async()=>{
    for(const intervalMs of [undefined,2*60*60*1000]) {
        const f=fixture();
        f.options.save({version:1,nextAt:1000000+(intervalMs ?? 4*60*60*1000),nextIndex:5,outcome:'confirmed',
            ...(intervalMs == null ? {} : {intervalMs})});
        await f.create().tick();assert.equal(f.calls.length,0);assert.equal(f.state().nextIndex,5);
        assert.equal(f.state().nextAt,1000000+6*60*60*1000);
        f.clock(6*60*60*1000-1);await f.create().tick();assert.equal(f.calls.length,0);
        f.clock(1);await f.create().tick();assert.equal(f.calls[0][1],CHAT_MESSAGES[5]);
        assert.equal(f.state().intervalMs,6*60*60*1000);
    }
});
