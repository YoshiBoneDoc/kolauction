import test from 'node:test';
import assert from 'node:assert/strict';
import { giftEnvelope, openedGiftPayload, prepareIncomingGifts, verifyGiftBalances } from '../src/incoming-gifts.mjs';
import { KolTransport } from '../src/transport.mjs';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';

const item = (id, quantity) => `<table class="item" rel="id=${id}&n=${quantity}"><tr><td><img title="fixture"></td></tr></table>`;
const gift = (id, body='BID 1048') => ({ id:String(id), type:'giftshop', fromid:String(800+id), fromname:`Player ${id}`, azunixtime:'1792715444', message:body+item(1167,1) });
const open = (raw, meat=100, items=[]) => ({ ...raw, message:raw.message+'<p>Inside Note:<p>Enjoy!'+(meat ? `<center>You gain ${meat} Meat</center>` : '')+items.map(i=>item(i.id,i.quantity)).join('') });

test('gift contents use the original sender/time/outside command and exclude the wrapper', () => {
    for (const cmd of ['LIST 1048','BID 1048','BUY 1048','FUND 1048','FILL 1048 00000000-0000-0000-0000-000000000001','BID 1048 51000']) {
        const raw=gift(1,cmd), opened=open(raw,51000,[{id:1,quantity:20}]);
        const mail=openedGiftPayload(giftEnvelope(raw),opened);
        assert.equal(mail.sender_id,801);assert.equal(mail.received_at,new Date(1792715444000).toISOString());
        assert.equal(mail.command.auction_number,'1048');assert.equal(mail.meat,51000);
        assert.deepEqual(mail.items,[{id:1,quantity:20}]);assert.equal(mail.raw.gift_original,opened);
    }
    const raw=gift(2,'A present for you');
    assert.equal(openedGiftPayload(giftEnvelope(raw),open(raw)).command.type,'donation');
    assert.equal(openedGiftPayload(giftEnvelope(gift(3)),open(gift(3)),true).command.type,'donation');
    assert.throws(()=>openedGiftPayload(giftEnvelope(raw),{...open(raw),fromid:'999'}),/original KMail/);
    const noWrapper={...open(raw),message:'A present for you<p>Inside Note:<p>Enjoy!<center>You gain 100 Meat</center>'};
    assert.equal(openedGiftPayload(giftEnvelope(raw),noWrapper).meat,100);
});

test('unrecognized wrappers, missing inventory or Meat and changed identity are held', () => {
    assert.throws(()=>giftEnvelope({...gift(1),message:'BID 1048'+item(1,1)}),/wrapper/);
    const mail=openedGiftPayload(giftEnvelope(gift(1)),open(gift(1),100,[{id:1,quantity:2}]));
    const before={meat:'500',items:{1167:2,1:3}};
    verifyGiftBalances(before,{meat:'600',items:{1167:1,1:5}},1167,mail);
    assert.throws(()=>verifyGiftBalances(before,{meat:'599',items:{1167:1,1:5}},1167,mail),/Meat/);
    assert.throws(()=>verifyGiftBalances(before,{meat:'600',items:{1167:1,1:4}},1167,mail),/item/);
});

function fixture(mails=[gift(1),gift(2,'A donation')]) {
    const rows=new Map(), calls=[];let attempt=null, serial=0, opens=0;
    let inbox=structuredClone(mails), inventory={meat:'500',items:{1167:mails.length}};
    const state=()=>({attempt:structuredClone(attempt),mails:[...rows.values()].map(row=>structuredClone(row))});
    const store={async rpc(name,args) {
        calls.push([name,args]);
        if(name==='bot_register_gift_mail') {
            for(const e of args.p_envelopes) if(!rows.has(e.id)) rows.set(e.id,{...e,payload:null,legacy_donation:false});
            return state();
        }
        if(name==='bot_claim_gift_open') { assert.equal(attempt,null);attempt={id:String(++serial),wrapper_id:1167,before_state:structuredClone(inventory)};return structuredClone(attempt); }
        if(name==='bot_finish_gift_open') {
            if(f.failAck) { f.failAck=false;throw new Error('DB unavailable'); }
            rows.get(args.p_mail.id).payload=args.p_mail;attempt=null;return;
        }
        throw new Error(name);
    }};
    const transport={client:{async fetchJson(){return structuredClone(inbox);}},
        async prepareTransfers(){return true;}, async snapshot(){return structuredClone(inventory);},
        async openGiftPackage(){
            opens++;
            if(f.noOpen) throw new Error('timeout');
            // Actual stack order deliberately differs from message order.
            const row=(f.forwardOpen ? [...inbox] : [...inbox].reverse()).find(raw=>!raw.message.includes('<p>Inside Note:<p>'));
            inbox=inbox.map(raw=>raw.id===row.id ? open(raw,100,[{id:1,quantity:f.badNext ? -2 : 2}]) : raw);
            f.badNext=false;
            inventory.meat=String(BigInt(inventory.meat)+100n);inventory.items[1167]--;
            inventory.items[1]=(inventory.items[1]||0)+2;
            if(f.timeout) throw new Error('timeout after success');
        }};
    const f={store,transport,shouldStop:()=>false,pause:async()=>{},log:()=>{},packageBudget:{1167:mails.length},calls,rows,
        get opens(){return opens;}, get attempt(){return attempt;}};
    return f;
}

test('mixed same-wrapper stack is correlated by updated KMail, donations remain separate',async()=>{
    const f=fixture();await prepareIncomingGifts(f);
    assert.equal(f.opens,2);assert.equal(f.transport.openedGifts.get('1').command.type,'bid');
    assert.equal(f.transport.openedGifts.get('2').command.type,'donation');
    assert.deepEqual(f.calls.filter(([n])=>n==='bot_finish_gift_open').map(([,p])=>p.p_mail.id),['2','1']);
    assert.equal(f.packageBudget[1167],'0');
    await prepareIncomingGifts(f);assert.equal(f.opens,2);
});

test('timeout after opening and database acknowledgment failures recover without reopening',async()=>{
    const f=fixture([gift(1)]);f.timeout=true;f.failAck=true;
    await assert.rejects(prepareIncomingGifts(f),/DB unavailable/);assert.equal(f.opens,1);
    await prepareIncomingGifts(f);assert.equal(f.opens,1);assert.equal(f.attempt,null);
    assert.equal(f.transport.openedGifts.get('1').meat,100);
});

test('an unconfirmed open stays held across cycles; no blind retry or second open',async()=>{
    const f=fixture();f.noOpen=true;
    await assert.rejects(prepareIncomingGifts(f),/unconfirmed/);
    await assert.rejects(prepareIncomingGifts(f),/unconfirmed/);
    assert.equal(f.opens,1);assert.ok(f.attempt);assert.equal(f.rows.get('1').payload,null);
});

test('package opening uses one raw request, no redirects, retries, or recovery wrapper',async()=>{
    const calls=[];const session=()=>{throw new Error('Recovery wrapper must never open gifts');};
    session.raw=async(path,options)=>{calls.push([path,options]);throw new Error('uncertain');};
    const transport=new KolTransport('kHub','fixture',{session});transport.nextRollover=Date.now()+3600000;
    await assert.rejects(transport.openGiftPackage(1167),/uncertain/);
    assert.equal(calls.length,1);assert.equal(calls[0][0],'inv_use.php');
    const options=calls[0][1];assert.equal(options.retry,0);assert.equal(options.redirect,'manual');
    assert.equal(options.body.get('whichitem'),'1167');assert.equal(options.body.get('quantity'),'1');
    await assert.rejects(transport.openGiftPackage(1),/not authorized/);assert.equal(calls.length,1);
});

test('worker verifies gift intake before staging bids and keeps gift source mail until cleanup permits it',async()=>{
    const { EscrowWorker }=await import('../src/worker.mjs');
    const f=fixture([gift(1)]);const rpc=f.store.rpc.bind(f.store);
    f.transport.inbox=async()=>{f.transport.inboxComplete=true;return [...f.transport.openedGifts.values()];};
    f.transport.closetSnapshot=f.transport.snapshot;
    const ingested=[];
    f.store.rpc=async(name,args)=>{
        if(name.startsWith('bot_')&&['bot_inspect','bot_begin_inbox_scan','bot_stage_inbox_scan','bot_ingest_mail','bot_finish_inbox_scan','bot_tick','bot_liabilities','bot_claim_delivery','bot_queue_gift_packages','bot_claim_closet_transfer','bot_mail_cleanup'].includes(name)) {
            f.calls.push([name,args]);
            if(name==='bot_inspect')return {attention:[],closetAttention:[],incomingGiftsVersion:1,receiptTimeBiddingVersion:1};
            if(name==='bot_begin_inbox_scan')return {id:'scan'};
            if(name==='bot_stage_inbox_scan'){assert.equal(f.opens,1);assert.equal(args.p_mails[0].meat,100);return [];}
            if(name==='bot_ingest_mail'){ingested.push(args.p_mail);return 'accepted';}
            if(name==='bot_liabilities')return {meat:'0',items:{}};
            if(name==='bot_mail_cleanup')return [];
            if(name==='bot_claim_delivery'){assert.equal(args.p_message_version,4);return null;}
            return null;
        }
        return rpc(name,args);
    };
    const worker=new EscrowWorker({...f,live:true});
    assert.equal((await worker.cycle()).state,'healthy');assert.equal(ingested.length,1);
    assert.equal(ingested[0].raw.gift_original.id,'1');assert.equal(ingested[0].meat,100);
    assert.deepEqual(f.calls.find(([name])=>name==='bot_mail_cleanup')[1].p_mail_ids,['1']);
});

function isolatedFixture(mails) {
    const f=fixture(mails), original=f.store.rpc.bind(f.store), reviews=new Map(), isolated=[];
    const getState=async()=>({ ...await original('bot_register_gift_mail',{p_envelopes:[]}),
        reviews:[...reviews.keys()],review_mail:[...reviews.values()],isolated:structuredClone(isolated) });
    let active=null;
    f.store.rpc=async(name,args)=>{
        if(name==='bot_gift_intake_state')return {...await getState(),attempt:active};
        if(name==='bot_register_gift_mail'){await original(name,args);return {...await getState(),attempt:active};}
        if(name==='bot_claim_gift_open'){
            const pending=[...f.rows.values()].find(row=>!row.payload&&!reviews.has(row.id));
            if(!pending)return null;
            active={id:'isolated-attempt-'+(f.opens+1),wrapper_id:1167,before_state:{...args.p_snapshot,requested_mail_id:pending.id}};
            f.calls.push([name,args]);return structuredClone(active);
        }
        if(name==='bot_isolate_gift_open'){
            const row=active || isolated.find(row=>row.id===args.p_attempt);
            if(row&&!isolated.some(a=>a.id===row.id))isolated.push({...row,state:'isolated'});
            for(const id of args.p_mail_ids)reviews.set(id,{mail_id:id,raw:f.rows.get(id).raw});
            active=null;f.calls.push([name,args]);return;
        }
        if(name==='bot_review_gift_mail'){reviews.set(String(args.p_raw.id),{mail_id:String(args.p_raw.id),raw:args.p_raw});return;}
        if(name==='bot_finish_gift_open'){
            if(f.commitThenFail){f.commitThenFail=false;f.rows.get(args.p_mail.id).payload=args.p_mail;active=null;throw new Error('lost ack');}
            f.rows.get(args.p_mail.id).payload=args.p_mail;reviews.delete(args.p_mail.id);active=null;
            f.calls.push([name,args]);return;
        }
        throw new Error(name);
    };
    f.reviews=reviews;f.isolated=isolated;
    return f;
}

test('isolated timeout skips to the next same-wrapper package and retains the unresolved mail',async()=>{
    const {prepareIsolatedGifts}=await import('../src/incoming-gifts.mjs');
    const f=isolatedFixture([gift(1),gift(2)]);const openPackage=f.transport.openGiftPackage;
    let first=true;f.transport.openGiftPackage=async()=>{
        f.noOpen=first;first=false;
        return openPackage.call(f.transport);
    };
    await prepareIsolatedGifts(f);
    assert.equal(f.opens,2);assert.equal(f.isolated.length,1);assert.ok(f.reviews.has('1'));
    assert.equal(f.transport.openedGifts.get('2').meat,100);
    assert.ok(f.transport.bankedGiftIds.has('1'));
    assert.equal(f.rows.get('1').payload,null);
});

test('a reviewed unopened stack entry can be identified on a later open without misattributing the other sender',async()=>{
    const {prepareIsolatedGifts}=await import('../src/incoming-gifts.mjs');
    const f=isolatedFixture([gift(2),gift(1)]);f.forwardOpen=true;const openPackage=f.transport.openGiftPackage;
    let first=true;f.transport.openGiftPackage=async()=>{f.noOpen=first;first=false;return openPackage.call(f.transport);};
    await prepareIsolatedGifts(f);
    // The second claim requested mail 1, but the physical stack opened reviewed mail 2.
    assert.equal(f.transport.openedGifts.get('1').sender_id,801);
    assert.equal(f.transport.openedGifts.get('2').sender_id,802);
    assert.equal(f.reviews.size,0);
});

test('isolation mode recovers a successful intake commit despite a lost acknowledgment',async()=>{
    const {prepareIsolatedGifts}=await import('../src/incoming-gifts.mjs');
    const f=isolatedFixture([gift(1)]);f.commitThenFail=true;
    await prepareIsolatedGifts(f);
    assert.equal(f.opens,1);assert.equal(f.isolated.length,0);assert.equal(f.reviews.size,0);
    assert.equal(f.transport.openedGifts.get('1').meat,100);
});

test('malformed opened contents are skipped, never allocated, and the next sender is processed',async()=>{
    const {prepareIsolatedGifts}=await import('../src/incoming-gifts.mjs');
    const f=isolatedFixture([gift(1),gift(2)]);f.badNext=true;
    await prepareIsolatedGifts(f);
    assert.equal(f.opens,2);assert.equal(f.rows.get('2').payload,null);assert.ok(f.reviews.has('2'));
    assert.equal(f.transport.openedGifts.get('1').sender_id,801);
    assert.deepEqual(f.transport.openedGifts.get('1').items,[{id:1,quantity:2}]);
    assert.ok(f.transport.bankedGiftIds.has('2'));
    await prepareIsolatedGifts(f);assert.equal(f.opens,2);
});

test('fresh transport snapshots refresh isolated-asset protection before dispatch reads balances',async()=>{
    const calls=[];
    const transport=new KolTransport('kHub','fixture',{
        async fetchStatus(){return {playerid:3888760,meat:12345,hardcore:0,roninleft:0,rollover:Math.floor(Date.now()/1000)+3600};},
        async fetchJson(){return {'1':'7'};},
    });
    transport.giftProtectionActive=true;transport.giftOperatingReserve=50;
    transport.giftProtectionStore={async rpc(name,args){calls.push([name,args]);}};
    assert.deepEqual(await transport.snapshot(),{meat:'12345',items:{'1':'7'}});
    assert.equal(calls.length,1);assert.equal(calls[0][0],'bot_refresh_gift_protection');
    assert.equal(calls[0][1].p_snapshot.reserve,50);
    assert.equal(calls[0][1].p_snapshot.meat,'12345');
});

// Real KoL Meat attachment shape: the empty inside note starts with this table.
const meatTable = '<center><table><tr><td><img src="https://images.kingdomofloathing.com/itemimages/meat.gif" height=30 width=30 alt="Meat"></td><td valign=center>You gain 100,000 Meat.</td></tr></table></center>';
test('empty inside note preserves Meat-only, item-only and mixed gift attachments',()=>{
    for(const note of ['', 'Enjoy!', '<br>']) for(const kind of ['meat','items','mixed']){
        const raw=gift(8,'BID 1082');
        const opened={...raw,message:raw.message+'<p>Inside Note:<p>'+note+(kind!=='items'?meatTable:'')+(kind!=='meat'?item(1,20):'')};
        const payload=openedGiftPayload(giftEnvelope(raw),opened);
        assert.equal(payload.meat,kind==='items'?0:100000);
        assert.deepEqual(payload.items,kind==='meat'?[]:[{id:1,quantity:20}]);
        assert.equal(payload.command.type,'bid');assert.equal(payload.command.auction_number,'1082');
        assert.ok(!payload.items.some(i=>i.id===1167));
        assert.equal(payload.received_at,new Date(Number(raw.azunixtime)*1000).toISOString());
    }
});
test('empty-note donations remain donations and regular KMail Valentine handling is unchanged',()=>{
    const raw=gift(9,'Thank you!');
    const opened={...raw,message:raw.message+'<p>Inside Note:<p>'+meatTable};
    const payload=openedGiftPayload(giftEnvelope(raw),opened);
    assert.equal(payload.command.type,'donation');assert.equal(payload.meat,100000);
    assert.equal(KmailMailbox.parse(meatTable,'normal').valentine,'unknown');
});
