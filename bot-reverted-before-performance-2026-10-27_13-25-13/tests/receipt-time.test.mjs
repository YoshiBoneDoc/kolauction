import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMail, parseInboxPage, readCompleteInbox } from '../src/inbox.mjs';
import { EscrowWorker } from '../src/worker.mjs';

const headerPage = (ids, heading) => `<b>${heading}</b><form>${ids.map(id=>`<input type=checkbox name=sel${id}>`).join('')}</form>`;
test('Inbox enumeration validates exact pagination and ignores message-body checkbox forgeries', () => {
    assert.deepEqual(parseInboxPage(headerPage(['12','13'],'Messages: Inbox, page 1 (1 - 2 of 3)')), {ids:['12','13'],total:3,next:2});
    const single=headerPage(['12'],'Messages: Inbox, page 1 (1 messages)')+'<blockquote><input type=checkbox name=sel99></blockquote>';
    assert.deepEqual(parseInboxPage(single),{ids:['12'],total:1,next:null});
    for(const html of ['<form>Login</form>',headerPage(['12'],'Messages: Sent, page 1 (1 messages)'),headerPage(['12'],'Messages: Inbox, page 1 (2 messages)')]) assert.throws(()=>parseInboxPage(html));
});
test('a saturated API response enumerates every Inbox page and fetches hidden older mail by ID', async () => {
    const latest=Array.from({length:100},(_,i)=>({id:String(i+2)}));const calls=[];
    const client={async fetchJson(path,options){calls.push({path,options});if(options.query.id){assert.equal(options.query.id,'1');return {id:'1'};}assert.equal(options.query.count,100);return latest;},
        session:{async raw(path,options){calls.push({path,options});assert.equal(options.method,'GET');assert.equal(options.retry,0);assert.equal(options.query.box,'Inbox');return {status:200,_data:options.query.begin==='1'
            ?headerPage(latest.map(m=>m.id),'Messages: Inbox, page 1 (1 - 100 of 101)')
            :headerPage(['1'],'Messages: Inbox, page 2 (101 - 101 of 101)')};}}};
    const all=await readCompleteInbox(client);assert.equal(all.length,101);assert.equal(new Set(all.map(m=>m.id)).size,101);
    assert.equal(calls.filter(c=>c.path==='messages.php').length,2);
    assert.ok(calls.every(c=>!c.options.form && !c.options.body));
});
test('an incomplete, changing or missing mailbox cannot silently become a complete scan', async () => {
    const latest=Array.from({length:100},(_,i)=>({id:String(i+2)}));
    for(const mode of ['changed','missing','unavailable']) {
        const client={async fetchJson(_path,options){return options.query.id?null:latest;},session:{async raw(_path,options){
            if(mode==='unavailable')throw Error('read failed');return {status:200,_data:options.query.begin==='1'
                ?headerPage(latest.map(m=>m.id),'Messages: Inbox, page 1 (1 - 100 of 101)')
                :headerPage(mode==='changed'?['1','102']:['1'],mode==='changed'?'Messages: Inbox, page 2 (101 - 102 of 102)':'Messages: Inbox, page 2 (101 - 101 of 101)')};}}};
        await assert.rejects(readCompleteInbox(client));
    }
});
test('mail ordering uses KoL timestamps then numeric message IDs', () => {
    const mails=[{id:'100',received_at:'2026-10-22T12:00:01Z'},{id:'99',received_at:'2026-10-22T12:00:01Z'},{id:'101',received_at:'2026-10-22T12:00:00Z'}];
    assert.deepEqual(mails.sort(compareMail).map(m=>m.id),['101','99','100']);
});
const mail=(id,time='2026-10-22T12:00:00Z')=>({id,received_at:time,command:{type:'bid'},meat:100,items:[],raw:{type:'normal'}});
function fixture({mails=[mail('2')],pending=mails,fail=null,complete=true}={}) {
    const calls=[];
    const store={async rpc(name,args){calls.push([name,args]);if(name===fail)throw Error('simulated failure');
        if(name==='bot_inspect')return {attention:[],receiptTimeBiddingVersion:1};
        if(name==='bot_begin_inbox_scan')return {id:'scan'};
        if(name==='bot_stage_inbox_scan')return pending;
        if(name==='bot_mail_cleanup')return args.p_mail_ids;
        if(name==='bot_liabilities')return {meat:'0',items:{}};
        return null;
    }};
    const transport={inboxComplete:complete,async inbox(){calls.push(['inbox']);if(fail==='inbox')throw Error('read failed');return mails;},
        async snapshot(){return {meat:'10000',items:{}};},async closetSnapshot(){return {meat:'10000',items:{},closetMeat:'0',closetItems:{}};},async acknowledge(id){calls.push(['delete',id]);},async send(){assert.fail('no delivery expected');}};
    return {calls,worker:new EscrowWorker({store,transport,live:true,log:()=>{}})};
}
test('worker durably stages and sorts recovered bids, then completes the scan before claiming deliveries', async () => {
    const f=fixture({mails:[mail('10')],pending:[mail('10'),mail('9')]});await f.worker.cycle();
    const names=f.calls.map(c=>c[0]);assert.ok(names.indexOf('bot_begin_inbox_scan')<names.indexOf('inbox'));
    assert.ok(names.indexOf('bot_stage_inbox_scan')<names.indexOf('bot_ingest_mail'));
    assert.deepEqual(f.calls.filter(c=>c[0]==='bot_ingest_mail').map(c=>c[1].p_mail.id),['9','10']);
    assert.ok(names.lastIndexOf('bot_ingest_mail')<names.indexOf('bot_finish_inbox_scan'));
    assert.ok(names.indexOf('bot_finish_inbox_scan')<names.indexOf('bot_tick'));
    assert.ok(names.indexOf('bot_tick')<names.indexOf('bot_claim_delivery'));
});
for(const fail of ['inbox','bot_stage_inbox_scan','bot_ingest_mail','bot_finish_inbox_scan'])test(`${fail} failure prevents finalization or transfer claims`,async()=>{
    const f=fixture({fail});await assert.rejects(f.worker.cycle());
    assert.ok(!f.calls.some(c=>['bot_tick','bot_claim_delivery','delete'].includes(c[0])));
});
test('unreadable raw mail prevents both the intake batch and its close authorization',async()=>{
    const f=fixture({complete:false});assert.equal((await f.worker.cycle()).state,'blocked');
    assert.ok(!f.calls.some(c=>['bot_stage_inbox_scan','bot_ingest_mail','bot_finish_inbox_scan','bot_claim_delivery'].includes(c[0])));
});
