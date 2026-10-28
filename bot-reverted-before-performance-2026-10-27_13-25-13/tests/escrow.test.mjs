import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, normalizeMail, assertSolvent, GiftBudgetDeferredError, GiftDeliveryError } from '../src/protocol.mjs';
import { KolTransport, recipientNeedsGift, recipientGiftStatus } from '../src/transport.mjs';
import { EscrowWorker } from '../src/worker.mjs';
import { KmailMailbox } from 'kol.js/domains/KmailMailbox';

const id = '00000000-0000-0000-0000-000000000001';
test('strict command parsing uses auction UUIDs and accepts a bare Auction ID as a bid', () => {
    assert.deepEqual(parseCommand(`bId ${id}`), {type:'bid',auction_id:id});
    assert.deepEqual(parseCommand(id), {type:'bid',auction_id:id});
    assert.equal(parseCommand(`BUY ${id}`).type,'buy');
    assert.equal(parseCommand('VERIFY '+ 'a'.repeat(32)).type,'verify');
    for(const text of [`BID ${id} blah`,`BID itemname`,`LIST ${id}\nBUY ${id}`]) assert.equal(parseCommand(text).type,'unknown');
});

test('short auction numbers work for LIST/BID/BUY without truncating or guessing UUIDs', () => {
    for(const type of ['list','bid','buy','fund','fill']) {
        assert.deepEqual(parseCommand(`${type.toUpperCase()} 1001`),{type,auction_number:'1001'});
        assert.deepEqual(parseCommand(`${type} #1001`),{type,auction_number:'1001'});
    }
    assert.deepEqual(parseCommand('1001'),{type:'bid',auction_number:'1001'});
    assert.deepEqual(parseCommand('BID 9223372036854775807'),{type:'bid',auction_number:'9223372036854775807'});
    for(const text of ['BID 0','BID -1','BID 01','BID 1.5','BID D-1001','BID 9223372036854775808','BID 1001 extra']) {
        assert.equal(parseCommand(text).type,'unknown');
    }
});
test('raw game KMail is normalized from sender IDs and parsed attachments, never amounts typed in body', () => {
    const raw={id:'41',fromid:'888',fromname:'Buyer',azunixtime:'1792411200',type:'normal',message:`BID ${id}<center>You gain 1,234 Meat</center>`};
    const mail=normalizeMail(raw,KmailMailbox.parse);
    assert.equal(mail.meat,1234);assert.equal(mail.sender_id,888);assert.equal(mail.command.auction_id,id);
    assert.deepEqual(mail.raw,raw);
    assert.equal(normalizeMail({...raw,message:`BID ${id} 1000000 Meat`},KmailMailbox.parse).command.type,'bid_help');
    assert.equal(normalizeMail({...raw,type:'giftshop'},KmailMailbox.parse).command.type,'donation');
    assert.throws(()=>normalizeMail({...raw,id:'unsafe'},KmailMailbox.parse),/message ID/);
});
test('solvency checks protect Meat reserve and item liabilities with exact integer math', () => {
    assertSolvent({meat:'9007199254740992',items:{1:2}},{meat:'9007199254740991',items:{1:'2'}},1);
    assert.throws(()=>assertSolvent({meat:'100',items:{}},{meat:'100',items:{}},1),/reserve/);
    assert.throws(()=>assertSolvent({meat:'100',items:{}},{meat:'0',items:{1:'2'}},0),/Item #1/);
});
test('donation packages become acknowledgment receipts without parsing their contents as commands/assets',async()=>{
    const normal={id:'41',fromid:'888',fromname:'Buyer',azunixtime:'1792411200',type:'normal',message:`BID ${id}`};
    const gift={...normal,id:'42',type:'giftshop',message:`BUY ${id}`};
    const client={async fetchJson(){return[gift,normal];}};
    const transport=new KolTransport('kHub','',client);
    const mails=await transport.inbox();
    assert.equal(mails.length,2);
    assert.equal(mails[0].id,'41');
    assert.equal(mails[0].command.type,'bid');
    assert.equal(mails[1].command.type,'donation');
    assert.equal(mails[1].meat,0);assert.deepEqual(mails[1].items,[]);
    assert.equal(mails[1].raw,gift);
    assert.equal(normalizeMail(gift,()=>{throw Error('Must not open/parse gift contents');}).command.type,'donation');
    assert.equal(normalizeMail(normal,()=>({insideNote:'BID '+id,valentine:false})),null);
    assert.equal(normalizeMail({...normal,type:'unrecognized'},KmailMailbox.parse),null);
});

test('normal DONATE mail records actual attached Meat/items and requires an exact command',()=>{
    assert.deepEqual(parseCommand('  DoNaTe  '),{type:'donation'});
    assert.equal(parseCommand('DONATE 1000').type,'unknown');
    const raw={id:'43',fromid:'888',fromname:'Donor',azunixtime:'1792411200',type:'normal',
        message:'DONATE<center>You gain 1,234 Meat</center><table class="item" rel="id=1&n=2"><tr><td><img title="seal tooth"></td></tr></table>'};
    const donation=normalizeMail(raw,KmailMailbox.parse);
    assert.equal(donation.command.type,'donation');assert.equal(donation.meat,1234);
    assert.deepEqual(donation.items,[{id:1,quantity:2}]);assert.equal(donation.raw.type,'normal');
});
function fixture({sendFails=false,ackFails=false,ingestFails=false,live=true}={}){
    const calls=[];const row={id,attempt:'attempt-1',recipient_id:888,kind:'sale_meat',meat:100,item_id:null,quantity:0,message:'Payout',state:'pending'};
    const store={async rpc(name,args){calls.push([name,args]);
        if(name==='bot_inspect')return{attention:['sending','unknown'].includes(row.state)?[row]:[]};
        if(name==='bot_ingest_mail'&&ingestFails)throw Error('DB unavailable');
        if(name==='bot_claim_review_notice')return null;
        if(name==='bot_mail_cleanup')return args.p_mail_ids;
        if(['bot_liabilities','bot_gift_wrapping_liabilities'].includes(name))return{meat:'100',items:{}};
        if(name==='bot_claim_delivery'){if(row.state==='sent')return null;row.state='sending';return{...row};}
        if(name==='bot_ack_delivery'){if(ackFails)throw Error('DB unavailable after send');row.state=args.p_sent?'sent':'unknown';}
    }};
    const transport={async inbox(){return[{id:'42',command:{type:'bid'},meat:100,items:[]}]},async acknowledge(){calls.push(['delete']);},async snapshot(){return{meat:10000,items:{}};},async closetSnapshot(){return{meat:'10000',items:{},closetMeat:'0',closetItems:{}};},async send(){calls.push(['send']);if(sendFails)throw Error('timeout');return'acknowledged';}};
    return {worker:new EscrowWorker({store,transport,live,reserve:1000,log:()=>{}}),row,calls};
}
test('receipt commits before deletion and a confirmed payout is acknowledged once',async()=>{
    const f=fixture();await f.worker.cycle();
    const names=f.calls.map(c=>c[0]);assert.ok(names.indexOf('bot_ingest_mail')<names.indexOf('delete'));
    assert.ok(names.indexOf('bot_ack_delivery')<names.indexOf('bot_claim_closet_transfer'));
    assert.ok(names.indexOf('bot_claim_closet_transfer')<names.indexOf('delete'));
    assert.equal(names.filter(n=>n==='send').length,1);assert.equal(f.row.state,'sent');
    assert.deepEqual(f.calls.find(c=>c[0]==='bot_claim_delivery')[1],{p_message_version:2});
});
test('failed receipt persistence never deletes the KMail or sends assets',async()=>{
    const f=fixture({ingestFails:true});await assert.rejects(f.worker.cycle(),/DB unavailable/);
    assert.ok(!f.calls.some(c=>['delete','send'].includes(c[0])));
});
test('read-only mode never mutates escrow, deletes mail, or sends payouts',async()=>{
    const f=fixture({live:false});await f.worker.cycle();assert.deepEqual(f.calls.map(c=>c[0]),['bot_inspect']);
});

test('donations use their dedicated receipt RPC and never delete the gift package',async()=>{
    const f=fixture();
    f.worker.transport.inbox=async()=>[{id:'42',command:{type:'donation'},meat:0,items:[],raw:{type:'giftshop'}}];
    await f.worker.cycle();
    assert.ok(f.calls.some(c=>c[0]==='bot_ingest_donation'));
    assert.ok(!f.calls.some(c=>['bot_ingest_mail','delete'].includes(c[0])));
});

test('normal donations delete source mail only after the donation receipt commits',async()=>{
    const f=fixture();
    f.worker.transport.inbox=async()=>[{id:'42',command:{type:'donation'},meat:100,items:[],raw:{type:'normal'}}];
    await f.worker.cycle();
    const names=f.calls.map(c=>c[0]);
    assert.ok(names.indexOf('bot_ingest_donation')<names.indexOf('delete'));
    assert.ok(!names.includes('bot_ingest_mail'));
});

test('read-only donation previews never queue acknowledgments',async()=>{
    const f=fixture({live:false});
    f.worker.transport.inbox=async()=>[{id:'42',command:{type:'donation'},meat:0,items:[]}];
    await f.worker.cycle();
    assert.deepEqual(f.calls.map(c=>c[0]),['bot_inspect']);
});

test('failed donation persistence leaves the package untouched and sends nothing',async()=>{
    const f=fixture();f.worker.transport.inbox=async()=>[{id:'42',command:{type:'donation'},meat:0,items:[]}];
    const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>{if(name==='bot_ingest_donation')throw Error('DB unavailable');return rpc(name,args);};
    await assert.rejects(f.worker.cycle(),/DB unavailable/);
    assert.ok(!f.calls.some(c=>['delete','send'].includes(c[0])));
});
for(const options of [{sendFails:true},{ackFails:true}])test(`uncertain send or lost acknowledgment blocks every resend after restart (${JSON.stringify(options)})`,async()=>{
    const f=fixture(options);await assert.rejects(f.worker.cycle());
    assert.ok(['sending','unknown'].includes(f.row.state));
    await f.worker.cycle(); // stays logged in and blocked, without resending or deleting
    assert.ok(!f.calls.some(c=>c[0]==='delete'));
    assert.equal(f.calls.filter(c=>c[0]==='send').length,1);
});
test('raw transport sends one request with retries and redirects disabled and a saved-copy marker',async()=>{
    const sent=[];const client={async fetchStatus(){return{playerid:'3888760',hardcore:false,roninleft:0};},async session(path,options){sent.push({path,options});return'<center>Message sent.</center>';}};
    const transport=new KolTransport('kHub','',client);
    await transport.send({id,recipient_id:888,meat:100,item_id:1,quantity:2,message:'Payout'});
    assert.equal(sent.length,1);assert.equal(sent[0].options.retry,0);assert.equal(sent[0].options.redirect,'error');
    assert.equal(sent[0].options.body.get('savecopy'),'on');assert.match(sent[0].options.body.get('message'),/kHub delivery/);
    client.session=async()=>'<center>Unrecognized server error.</center>';
    await assert.rejects(transport.send({id,recipient_id:888,meat:100,message:'Payout'}),/acknowledgment/);
    client.fetchStatus=async()=>({playerid:'123'});await assert.rejects(transport.identity(),/Wrong KoL account/);
});

test('empty game inventory is a valid zero-asset snapshot',async()=>{
    const client={async fetchStatus(){return{playerid:'3888760',hardcore:false,roninleft:0,meat:1000};},async fetchJson(){return [];}};
    const transport=new KolTransport('kHub','',client);
    assert.deepEqual(await transport.snapshot(),{meat:'1000',items:{}});
});

test('friendly delivery uses the short persisted marker and keeps UUIDs out of the message body',async()=>{
    let body;let sends=0;
    const client={async fetchStatus(){return{playerid:'3888760',hardcore:false,roninleft:0};},async session(path,options){sends++;body=options.body;return'<center>Message sent.</center>';}};
    const transport=new KolTransport('kHub','',client);
    const delivery={id,recipient_id:888,meat:719,message:'Internal ledger '+id,
        display_message:'Bid accepted\n\nMr. Accessory × 1\nAuction #1001\n\nYour bid of 719 Meat was accepted.',
        delivery_reference:'D-1042',reference_marker:'Reference: D-1042'};
    await transport.send(delivery);
    assert.equal(body.get('message'),delivery.display_message+'\n\nReference: D-1042');
    assert.ok(!body.get('message').includes(id));
    assert.equal(body.get('sendmeat'),'719');
    await assert.rejects(transport.send({...delivery,reference_marker:'Reference: D-9999'}),/Invalid delivery reference/);
    assert.equal(sends,1);
});

test('donation contact follows the short reference without exposing the internal UUID',async()=>{
    let body;
    const client={async fetchStatus(){return{playerid:'3888760',hardcore:false,roninleft:0};},async session(path,options){body=options.body;return'<center>Message sent.</center>';}};
    const transport=new KolTransport('kHub','',client);
    const footer='\n*If this donation was sent in error, please KMail teres minor (#3552305) with the reference ID above.';
    await transport.send({id,recipient_id:888,meat:0,display_message:'Thank you!',
        display_footer:footer,delivery_reference:'D-1027',reference_marker:'Reference: D-1027'});
    assert.equal(body.get('message'),'Thank you!\n\nReference: D-1027\n'+footer);
    assert.ok(!body.get('message').includes(id));
});

test('read-only logs redact verification challenges',async()=>{
    const f=fixture({live:false});
    const token='a'.repeat(32);
    f.worker.transport.inbox=async()=>[{id:'1',command:{type:'verify',token},meat:0,items:[]}];
    let log='';f.worker.log=value=>{log=value;};
    await f.worker.cycle();assert.ok(!log.includes(token));assert.match(log,/redacted/);
});

test('operator logs use short references for routine sends and preserve UUIDs on uncertainty',async()=>{
    for (const options of [{},{sendFails:true},{ackFails:true},{sendFails:true,ackFails:true}]) {
        const f=fixture(options);f.row.delivery_reference='D-1042';
        const logs=[];f.worker.log=line=>logs.push(line);
        let failure;
        try { await f.worker.cycle(); } catch(error) { failure=error; }
        const sending=logs.find(line=>line.startsWith('[MAIL D-1042] Sending'));
        assert.ok(sending);
        assert.ok(!sending.includes(id));
        assert.match(sending,/player #888/);
        assert.ok(!sending.includes('item #none'));
        if(failure) assert.ok(failure.message.includes('D-1042') && failure.message.includes(id));
        else assert.match(logs.at(-1),/\[MAIL D-1042\] Send acknowledged/);
    }
});


test('unrelated, system, unsupported and malformed mail stays in the inbox without blocking valid commands',async()=>{
    const base={id:'90',fromid:'888',fromname:'Buyer',azunixtime:'1792411200',type:'normal',message:'BID 1001'};
    const rows=[{...base,id:'91',type:'unknown'}, {...base,id:'92',fromid:'0'},
        {...base,id:'93',fromid:'3888760'}, {...base,id:'94',message:'hello'},
        {...base,id:'95',message:'<center><table>valentine</table></center>BID 1001'},
        {...base,id:'bad'}, {...base,id:'96',message:'hello<center>You gain 50 Meat</center>'},null,base];
    const logs=[];
    const transport=new KolTransport('kHub','',{async fetchJson(){return rows;}},message=>logs.push(message));
    assert.deepEqual((await transport.inbox()).map(mail=>mail.id),['90','96']);
    const count=logs.length;await transport.inbox();assert.equal(logs.length,count);
    assert.ok(logs.some(message=>message.startsWith('[MAIL CONTEXT KMail 94]')&&message.includes('Buyer (#888)')&&message.includes('hello')));
    assert.ok(logs.some(message=>message.startsWith('[MAIL CONTEXT KMail 95]')&&message.includes('BID 1001')));
});

test('unknown funded mail uses normal refund ingestion; empty unrelated mail is ignored',async()=>{
    const f=fixture();
    f.worker.transport.inbox=async()=>[{id:'91',command:{type:'unknown'},meat:50,items:[]},
        {id:'92',command:{type:'bid'},meat:100,items:[]}, {id:'93',command:{type:'unknown'},meat:0,items:[]}];
    await f.worker.cycle();
    assert.deepEqual(f.calls.filter(([name])=>name==='bot_ingest_mail').map(([,args])=>args.p_mail.id),['91','92']);
    assert.deepEqual(f.calls.find(([name])=>name==='bot_mail_cleanup')[1],{p_mail_ids:['91','92']});
});

test('uncertain transfers produce a separately tracked asset-free notice and remain blocked',async()=>{
    const f=fixture();f.row.state='unknown';
    const rpc=f.worker.store.rpc;let claimed=false;
    f.worker.store.rpc=async(name,args)=>{
        if(name==='bot_claim_review_notice'){
            if(claimed)return null;claimed=true;
            return{id:'notice-id',attempt:'notice-attempt',kind:'notice',meat:0,item_id:null,quantity:0,recipient_id:888,message:'Manual review'};
        }
        if(name==='bot_ack_delivery'){
            assert.equal(args.p_id,'notice-id');assert.equal(args.p_sent,true);return;
        }
        return rpc(name,args);
    };
    await f.worker.cycle();await f.worker.cycle();
    assert.equal(f.calls.filter(([name])=>name==='send').length,1);
    assert.equal(f.row.state,'unknown');
    assert.ok(!f.calls.some(([name])=>['delete','bot_ingest_mail','bot_claim_delivery'].includes(name)));
});

test('cleanup failures do not repeat an acknowledged transfer',async()=>{
    const f=fixture();f.worker.transport.acknowledge=async()=>{throw Error('delete failed');};
    await f.worker.cycle();await f.worker.cycle();
    assert.equal(f.row.state,'sent');assert.equal(f.calls.filter(([name])=>name==='send').length,1);
});

test('legacy database without closet isolation still blocks uncertain transfers',async()=>{
    const f=fixture();
    f.worker.store.rpc=async(name)=>{
        assert.equal(name,'bot_inspect');
        return{attention:[],closetAttention:[{id,closet_reference:'C-1001'}]};
    };
    f.worker.transport.inbox=async()=>assert.fail('intake must wait for closet reconciliation');
    await f.worker.cycle();
    assert.ok(!f.calls.some(([name])=>['send','delete','move'].includes(name)));
});

test('isolated closet uncertainty keeps intake, funded payouts and cleanup running across cycles',async()=>{
    const f=fixture();const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>{
        if(name==='bot_inspect')return{attention:[],closetIsolationVersion:1,closetAttention:[{id,closet_reference:'C-1001',attempt:'a'}]};
        if(name==='bot_isolate_closet_transfers'){f.calls.push([name]);return;}
        return rpc(name,args);
    };
    await f.worker.cycle();await f.worker.cycle();
    assert.equal(f.calls.filter(([name])=>name==='send').length,1);
    assert.ok(f.calls.some(([name])=>name==='bot_ingest_mail'));
    assert.ok(f.calls.some(([name])=>name==='delete'));
    assert.equal(f.calls.filter(([name])=>name==='bot_isolate_closet_transfers').length,1);
});

for (const ackFails of [false,true]) test(`a new uncertain closet write preserves cleanup even if acknowledgment fails: ${ackFails}`,async()=>{
    const f=fixture();const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>{
        if(name==='bot_inspect')return{attention:[],closetIsolationVersion:1};
        if(name==='bot_claim_closet_transfer'){f.calls.push(['closet-claim']);return{id:'closet',attempt:'a',meat:50,item_id:null,quantity:0,closet_reference:'C-1001'};}
        if(name==='bot_ack_closet_transfer'){f.calls.push([name,args]);if(ackFails)throw Error('DB acknowledgment unavailable');return;}
        if(name==='bot_isolate_closet_transfers'){f.calls.push([name]);return;}
        return rpc(name,args);
    };
    f.worker.transport.depositCloset=async()=>{throw Error('timeout');};
    await f.worker.cycle();
    assert.ok(f.calls.some(([name,args])=>name==='bot_ack_closet_transfer'&&args.p_moved===false));
    assert.ok(f.calls.some(([name])=>name==='bot_isolate_closet_transfers'));
    assert.ok(f.calls.some(([name])=>name==='delete'));
});

test('closet isolation never bypasses a real player asset shortage',async()=>{
    const f=fixture();const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>name==='bot_inspect'?{attention:[],closetIsolationVersion:1,closetAttention:[{id}]}:rpc(name,args);
    f.worker.transport.snapshot=async()=>({meat:0,items:{}});
    await assert.rejects(f.worker.cycle(),/Meat|reserve/);
    assert.ok(!f.calls.some(([name])=>name==='send'));
});

test('historical donation review is queued before payouts and never routed through donation ingestion',async()=>{
    const f=fixture();const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>{
        if(name==='bot_inspect')return{attention:[],mailPolicyAttention:[{receipt_id:'42'}]};
        return rpc(name,args);
    };
    f.worker.transport.inbox=async()=>[{id:'42',command:{type:'unknown'},meat:100,items:[],raw:{type:'normal'}}];
    await f.worker.cycle();
    const names=f.calls.map(([name])=>name);
    assert.ok(names.includes('bot_queue_previous_donation_refunds'));
    assert.ok(names.indexOf('bot_queue_previous_donation_refunds')<names.indexOf('bot_claim_delivery'));
    assert.ok(!names.includes('bot_ingest_donation'));
});

test('package budget subtracts acknowledged item returns before sweeping later arrivals',async()=>{
    const f=fixture();f.row.kind='refund';f.row.meat=0;f.row.item_id=1167;f.row.quantity=2;
    f.worker.transport.snapshot=async()=>({meat:'10000',items:{1167:'5'}});
    f.worker.transport.closetSnapshot=async()=>({meat:'10000',closetMeat:'0',items:{1167:'8'},closetItems:{}});
    await f.worker.cycle();
    assert.deepEqual(f.calls.find(([name])=>name==='bot_queue_gift_packages')[1].p_inventory,{1167:'3'});
});


test('normalized Meat above the former 20-billion limit remains exact', () => {
    const raw={id:'42',fromid:'888',fromname:'Buyer',azunixtime:'1792411200',type:'normal',message:`BID ${id}<center>You gain 50,000,000,001 Meat</center>`};
    assert.equal(normalizeMail(raw,KmailMailbox.parse).meat,50000000001);
    assert.throws(()=>normalizeMail({...raw,message:`BID ${id}<center>You gain 9,007,199,254,740,992 Meat</center>`},KmailMailbox.parse),/Meat/);
});


function giftFixture({ regular = '<center>That player cannot receive Meat or items.</center>', gift = '<td>Package sent.</td>', costFails = false } = {}) {
    const requests = [], costs = [];
    const client = {
        async fetchStatus() { return { playerid: '3888760', hardcore: false, roninleft: 0 }; },
        async session(path, options) {
            requests.push({ path, options });
            const result = path === 'sendmessage.php' ? regular : gift;
            if (result instanceof Error) throw result;
            return result;
        },
    };
    const transport = new KolTransport('kHub', '', client, () => {});
    const row = { id, recipient_id: 888, meat: 1000, item_id: 908, quantity: 2,
        display_message: 'Your attachments are returned.', delivery_reference: 'D-1096', reference_marker: 'Reference: D-1096' };
    const options = { async authorizeGift(cost) { costs.push(cost); if (costFails) throw Error('No spare operating Meat'); } };
    return { transport, row, options, requests, costs };
}

test('explicit recipient restriction falls back once to a gift with identical assets and reference', async () => {
    const f = giftFixture();
    const proof = await f.transport.send(f.row, f.options);
    assert.deepEqual(f.costs, [50]);
    assert.deepEqual(f.requests.map(r => r.path), ['sendmessage.php', 'town_sendgift.php']);
    const { body, retry, redirect } = f.requests[1].options;
    assert.equal(retry, 0); assert.equal(redirect, 'error');
    for (const [key, expected] of Object.entries({ action: 'Yep.', towho: '888', whichpackage: '1', fromwhere: '0', sendmeat: '1000', whichitem1: '908', howmany1: '2', savecopy: 'on' })) assert.equal(body.get(key), expected);
    assert.equal(body.get('note'), 'Your attachments are returned. | Reference: D-1096');
    assert.equal(f.requests[0].options.body.get('message'), 'Your attachments are returned.\n\nReference: D-1096');
    assert.equal(body.get('insidenote'), body.get('note'));
    assert.match(proof, /gift-package acknowledgment; wrapping cost 50 Meat/);
});

test('Meat-only and item-only refunds retain their full contents in the gift fallback', async () => {
    for (const extra of [{ item_id: null, quantity: 0 }, { meat: 0 }]) {
        const f = giftFixture();
        await f.transport.send({ ...f.row, ...extra }, f.options);
        const body = f.requests[1].options.body;
        assert.equal(body.get('sendmeat'), String(extra.meat ?? 1000));
        assert.equal(body.get('whichitem1'), extra.item_id === null ? null : '908');
    }
});

test('successful mail, generic errors, quotes, redirects and timeouts never trigger a gift resend', async () => {
    for (const regular of ['<center>Message sent.</center>', '<center>Something went wrong.</center>',
        '<blockquote><center>That player cannot receive Meat or items.</center></blockquote>',
        '<html>Login required</html>', Error('timeout'),
        '<center>Message sent.</center><center>That player cannot receive Meat or items.</center>']) {
        const f = giftFixture({ regular });
        try { await f.transport.send(f.row, f.options); } catch { /* Unknown outcomes stay uncertain. */ }
        assert.equal(f.requests.length, 1);
        assert.equal(f.costs.length, 0);
    }
});

test('gift wrapping requires spare operating funds and never reduces the recipient payment', async () => {
    const f = giftFixture({ costFails: true });
    await assert.rejects(f.transport.send(f.row, f.options), /gift not attempted/);
    assert.equal(f.requests.length, 1);
    await assert.rejects(f.transport.send(f.row), /operating-funds check/);
    assert.equal(f.requests.length, 2);
});

test('an unconfirmed gift send is never repeated or treated as a successful refund', async () => {
    for (const gift of [Error('gift timeout'), '<td>Daily limit reached.</td>', '<html>Login required</html>']) {
        const f = giftFixture({ gift });
        await assert.rejects(f.transport.send(f.row, f.options), /Gift package outcome uncertain/);
        assert.equal(f.requests.length, 2);
    }
});


test('worker gift authorization protects full liabilities, reserve and unread inbox assets', async () => {
    for (const [balance, reviewMeat, allowed] of [[1149, 0, false], [1150, 0, true], [1150, 1, false]]) {
        const f = fixture();
        f.worker.transport.snapshot = async () => ({ meat: String(balance), items: {} });
        f.worker.transport.reviewHolds = { meat: String(reviewMeat), uncertain: false };
        let giftSent = false;
        f.worker.transport.send = async (_, { authorizeGift }) => {
            await authorizeGift(50);
            giftSent = true;
            return 'KoL gift-package acknowledgment';
        };
        if (allowed) await f.worker.cycle();
        else await assert.rejects(f.worker.cycle());
        assert.equal(giftSent, allowed);
        assert.equal(f.row.state, allowed ? 'sent' : 'unknown');
    }
});


const restrictedProfile = (id = 888, state = 'Hardcore') =>
    `<center><table><tr><td><center><span><b>Player</b> (#${id})<br></span>Level 10<br>${state ? `<b>(${state})</b>` : ''}</center></td></tr></table></center>`;

test('recipient profile checks require the matching player header and explicit HC/Ronin status', () => {
    for (const state of ['Hardcore', 'In Ronin']) {
        assert.equal(recipientNeedsGift(restrictedProfile(888, state), 888), true);
        assert.equal(recipientNeedsGift(restrictedProfile(999, state), 888), false);
        assert.equal(recipientNeedsGift(`<blockquote>${restrictedProfile(888, state)}</blockquote>`, 888), false);
    }
    assert.equal(recipientNeedsGift(restrictedProfile(888, ''), 888), false);
    assert.equal(recipientNeedsGift('<html>Log in first</html>', 888), false);
});

test('a fresh restricted profile selects a gift before any normal KMail asset request', async () => {
    for (const state of ['Hardcore', 'In Ronin']) {
        const f = giftFixture();
        const reads = [];
        f.transport.client.session.raw = async (path, options) => {
            reads.push([path, options]);
            return { status: 200, _data: restrictedProfile(888, state) };
        };
        const proof = await f.transport.send(f.row, f.options);
        assert.deepEqual(f.requests.map(row => row.path), ['town_sendgift.php']);
        assert.equal(reads.length, 1);
        assert.equal(reads[0][0], 'showplayer.php');
        assert.equal(reads[0][1].query.who, '888');
        assert.equal(reads[0][1].method, 'GET');
        assert.equal(reads[0][1].retry, 0);
        assert.equal(reads[0][1].redirect, 'manual');
        assert.match(proof, /gift-package acknowledgment/);
    }
});

test('failed, redirected and wrong-player profile reads do not authorize a gift', async () => {
    for (const profile of [Error('timeout'), { status: 302, _data: restrictedProfile() },
        { status: 200, _data: restrictedProfile(999) }, { status: 200, _data: '<html>Log in first</html>' }]) {
        const f = giftFixture({ regular: '<center>Message sent.</center>' });
        f.transport.client.session.raw = async () => { if (profile instanceof Error) throw profile; return profile; };
        await f.transport.send(f.row, f.options);
        assert.deepEqual(f.requests.map(row => row.path), ['sendmessage.php']);
    }
});

test('recipient status is refreshed for each asset send and skipped for plain notices', async () => {
    const f = giftFixture({ regular: '<center>Message sent.</center>' });
    let reads = 0;
    f.transport.client.session.raw = async () => ({ status: 200, _data: restrictedProfile(888, reads++ ? 'Hardcore' : '') });
    await f.transport.send(f.row, f.options);
    await f.transport.send(f.row, f.options);
    await f.transport.send({ ...f.row, meat: 0, item_id: null }, f.options);
    assert.equal(reads, 2);
    assert.deepEqual(f.requests.map(row => row.path), ['sendmessage.php', 'town_sendgift.php', 'sendmessage.php']);
});

test('an unconfirmed direct gift never falls back to regular mail or sends another gift', async () => {
    const f = giftFixture({ gift: Error('timeout') });
    f.transport.client.session.raw = async () => ({ status: 200, _data: restrictedProfile() });
    await assert.rejects(f.transport.send(f.row, f.options), /Gift package outcome uncertain/);
    assert.deepEqual(f.requests.map(row => row.path), ['town_sendgift.php']);
});

test('restriction error recognition tolerates surrounding game UI and extra explanation', async () => {
    const f = giftFixture({ regular: '<center><b>Message not sent</b><p>That player cannot receive Meat or items at the moment. Try sending a gift instead.</p></center>' });
    await f.transport.send(f.row, f.options);
    assert.equal(f.requests.length, 2);
});


test('gift notes use readable separators instead of multiline KMail breaks in both HC/Ronin and fallback sends', async () => {
    for (const state of [null, 'Hardcore', 'In Ronin']) {
        const f = giftFixture();
        f.row.display_message = 'Request not accepted\r\n\r\nInvalid command. Please copy the correct KMail command.\n\nYour attached Meat or items are being returned.';
        f.row.display_footer = 'Official bot: kHub (#3888760)\rQuestions? Contact an administrator.';
        const saved = structuredClone(f.row);
        if (state) f.transport.client.session.raw = async () => ({ status: 200, _data: restrictedProfile(888, state) });
        await f.transport.send(f.row, f.options);
        const gifts = f.requests.filter(request => request.path === 'town_sendgift.php');
        assert.equal(gifts.length, 1);
        const { body } = gifts[0].options;
        const expected = 'Request not accepted | Invalid command. Please copy the correct KMail command. | Your attached Meat or items are being returned. | Reference: D-1096 | Official bot: kHub (#3888760) | Questions? Contact an administrator.';
        assert.equal(body.get('note'), expected);
        assert.equal(body.get('insidenote'), expected);
        assert.doesNotMatch(body.get('note'), /[\r\n]/);
        assert.doesNotMatch(body.toString(), /%0[AD]/i);
        assert.equal(body.get('sendmeat'), '1000');
        assert.equal(body.get('whichitem1'), '908');
        assert.equal(body.get('howmany1'), '2');
        assert.equal(body.get('towho'), '888');
        assert.equal(gifts[0].options.retry, 0);
        assert.deepEqual(f.row, saved);
        if (!state) assert.equal(f.requests[0].options.body.get('message'), `${saved.display_message}\n\n${saved.reference_marker}\n${saved.display_footer}`);
        else assert.deepEqual(f.requests.map(request => request.path), ['town_sendgift.php']);
    }
});


test('buy funding and fulfillment mail use durable intake before cleanup, without altering sell commands',async()=>{
    for(const type of ['fund','fill']) {
        assert.deepEqual(parseCommand(`${type} ${id}`),{type,auction_id:id});
        const f=fixture();f.worker.transport.inbox=async()=>[{id:'42',command:{type,auction_number:'1001'},meat:type==='fund'?100:0,items:type==='fill'?[{id:1,quantity:2}]:[]}];
        await f.worker.cycle();const names=f.calls.map(c=>c[0]);assert.ok(names.indexOf('bot_ingest_mail')>=0);assert.ok(names.indexOf('bot_ingest_mail')<names.indexOf('delete'));
    }
});


test('reserved FILL commands preserve auction and reservation IDs without accepting malformed extras',()=>{
 const reservation='12345678-1234-1234-1234-123456789abc';
 assert.deepEqual(parseCommand(`FILL #1200 ${reservation}`),{type:'fill',auction_number:'1200',reservation_id:reservation});
 assert.deepEqual(parseCommand(`FILL ${id} ${reservation}`),{type:'fill',auction_id:id,reservation_id:reservation});
 for(const text of [`FILL 1200 ${reservation} extra`,`FILL 1200 not-a-reservation`,`FILL 9223372036854775808 ${reservation}`])assert.equal(parseCommand(text).type,'unknown');
});

test('Buy item gifts authorize kHub packaging before sending, without charging ordinary deliveries',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);let gifted=false;
 f.worker.store.rpc=async(name,args)=>{if(name==='bot_charge_buy_gift'){f.calls.push([name,args]);return {authorized:true,payer:'bot'};}return original(name,args);};
 f.worker.transport.send=async(_,options)=>{const result=await options.authorizeGift(50);assert.equal(result.payer,'bot');gifted=true;return 'gift sent';};
 await f.worker.sendDelivery({...f.row,kind:'sale_item',dedupe_key:'buy-fill-items:42',item_id:1,quantity:2,meat:0});
 assert.equal(gifted,true);assert.equal(f.calls.filter(([name])=>name==='bot_charge_buy_gift').length,1);assert.equal(f.row.state,'sent');
 const ordinary=fixture();ordinary.worker.transport.send=async()=> 'regular mail sent';
 await ordinary.worker.sendDelivery({...ordinary.row,kind:'sale_item',dedupe_key:'buy-fill-items:42',item_id:1,quantity:2,meat:0});
 assert.equal(ordinary.calls.some(([name])=>name==='bot_charge_buy_gift'),false);
});

test('a required Buy batch recheck defers only that delivery; no asset attempt, unknown state or duplicate send',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);let attempted=false;
 f.worker.store.rpc=async(name,args)=>{if(name==='bot_charge_buy_gift'){f.calls.push([name,args]);return {authorized:false,payer:'bot',reason:'batch_recheck'};}if(name==='bot_defer_buy_delivery'){f.calls.push([name,args]);f.row.state='pending';return;}return original(name,args);};
 f.worker.transport.send=async(_,options)=>{await options.authorizeGift(50);attempted=true;};
 await f.worker.sendDelivery({...f.row,kind:'sale_item',dedupe_key:'buy-fill-items:42',item_id:1,quantity:2,meat:0});
 assert.equal(attempted,false);assert.equal(f.row.state,'pending');assert.equal(f.calls.some(([name])=>name==='bot_ack_delivery'),false);assert.equal(f.calls.filter(([name])=>name==='bot_defer_buy_delivery').length,1);
});

test('gift transport propagates a definite budget deferral before any gift request',async()=>{
 const f=giftFixture();f.transport.client.session.raw=async()=>({status:200,_data:restrictedProfile()});
 await assert.rejects(f.transport.send(f.row,{authorizeGift:async()=>{throw new GiftBudgetDeferredError();}}),GiftBudgetDeferredError);
 assert.equal(f.requests.length,0);
 const paid=giftFixture();paid.transport.client.session.raw=async()=>({status:200,_data:restrictedProfile()});
 const proof=await paid.transport.send(paid.row,{authorizeGift:async()=>({payer:'buyer'})});
 assert.match(proof,/paid by buyer escrow/);assert.equal(paid.requests.length,1);
});

test('a buy gift timeout remains uncertain and cannot release its charge or retry',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);
 f.worker.store.rpc=async(name,args)=>name==='bot_charge_buy_gift'?{authorized:true,payer:'bot'}:original(name,args);
 f.worker.transport.send=async(_,options)=>{await options.authorizeGift(50);throw new GiftDeliveryError();};
 await assert.rejects(f.worker.sendDelivery({...f.row,kind:'sale_item',dedupe_key:'buy-fill-items:42',item_id:1,quantity:2,meat:0}),/reconciliation/);
 assert.equal(f.row.state,'unknown');assert.equal(f.calls.some(([name])=>name==='bot_defer_buy_delivery'),false);
});


test('typed bid amounts get help without being treated as attached funds or a valid bid',()=>{
 for(const message of ['BID 1048 51000','bid #1048 51,000 Meat',`BID ${id} 51k`]){
  const raw={id:'206072560',fromid:'1588652',fromname:'astroNOmyKING',azunixtime:'1792715444',type:'normal',message};
  const mail=normalizeMail(raw,KmailMailbox.parse);
  assert.equal(mail.command.type,'bid_help');assert.equal(mail.meat,0);assert.deepEqual(mail.items,[]);
  assert.equal(normalizeMail({...raw,fromid:'0'},KmailMailbox.parse),null);
  assert.equal(normalizeMail({...raw,fromid:'3888760'},KmailMailbox.parse),null);
  assert.equal(normalizeMail({...raw,type:'giftshop'},KmailMailbox.parse).command.type,'donation');
 }
 const mail=normalizeMail({id:'123',fromid:'888',fromname:'Buyer',azunixtime:'1792715444',type:'normal',message:'BID 1048 51000<center>You gain 51,000 Meat</center>'},KmailMailbox.parse);
 assert.equal(mail.command.type,'bid_help');assert.equal(mail.meat,51000);
 assert.equal(parseCommand('BID 1048').type,'bid');
 assert.equal(parseCommand('Hello, I wanted to bid 51000').type,'unknown');
 assert.equal(parseCommand('BID 1048 51000\nBUY 1048').type,'unknown');
});

test('unfunded bid-help mail reaches durable ingestion and existing acknowledged cleanup',async()=>{
 const f=fixture();
 f.worker.transport.inbox=async()=>[{id:'206072560',command:{type:'bid_help',auction_number:'1048'},meat:0,items:[],raw:{type:'normal'}}];
 await f.worker.cycle();
 assert.deepEqual(f.calls.filter(([name])=>name==='bot_ingest_mail').map(([,args])=>args.p_mail.id),['206072560']);
 assert.deepEqual(f.calls.find(([name])=>name==='bot_mail_cleanup')[1],{p_mail_ids:['206072560']});
});


test('fresh recipient checks distinguish normal players, HC/Ronin and unverified profiles',async()=>{
 assert.equal(recipientGiftStatus(restrictedProfile(888,''),888),false);
 assert.equal(recipientGiftStatus(restrictedProfile(888,'Hardcore'),888),true);
 assert.equal(recipientGiftStatus(restrictedProfile(888,'In Ronin'),888),true);
 assert.equal(recipientGiftStatus(restrictedProfile(999,'(Hardcore)'),888),null);
 assert.equal(recipientGiftStatus('<html>Please log in</html>',888),null);
 const f=giftFixture();
 f.transport.client.session.raw=async()=>({status:200,_data:restrictedProfile(888,'')});
 assert.equal(await f.transport.recipientGiftStatus(888),false);
 f.transport.client.session.raw=async()=>{throw Error('Offline');};
 assert.equal(await f.transport.recipientGiftStatus(888),null);
 assert.equal(f.requests.length,0);
});

test('Buy batches are prepared after all intake and before version-3 delivery claims',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);
 f.worker.transport.inbox=async()=>[1,2].map(i=>({id:String(i),command:{type:'fill'},meat:0,items:[{id:1,quantity:2}],raw:{type:'normal'}}));
 f.worker.transport.recipientGiftStatus=async()=>true;
 f.worker.store.rpc=async(name,args)=>{
  if(name==='bot_inspect')return {...await original(name,args),buyDeliveryBatchingVersion:1};
  if(name==='bot_pending_buy_delivery_groups'){f.calls.push([name,args]);return [{auction_id:'buy-order',recipient_id:888}];}
  if(name==='bot_prepare_buy_delivery'){f.calls.push([name,args]);return {state:'batched',quantity:521};}
  return original(name,args);
 };
 await f.worker.cycle();
 const names=f.calls.map(([name])=>name);
 assert.ok(names.lastIndexOf('bot_ingest_mail')<names.indexOf('bot_prepare_buy_delivery'));
 assert.ok(names.indexOf('bot_prepare_buy_delivery')<names.indexOf('bot_claim_delivery'));
 assert.deepEqual(f.calls.find(([name])=>name==='bot_prepare_buy_delivery')[1],{p_auction_id:'buy-order',p_needs_gift:true});
 assert.equal(f.calls.find(([name])=>name==='bot_claim_delivery')[1].p_message_version,3);
});

test('an accumulated 521-item Buy delivery uses one kHub-paid package with the whole quantity',async()=>{
 const f=giftFixture();f.transport.client.session.raw=async()=>({status:200,_data:restrictedProfile()});
 const proof=await f.transport.send({...f.row,meat:0,quantity:521},{authorizeGift:async()=>({payer:'bot'})});
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].path,'town_sendgift.php');
 assert.equal(f.requests[0].options.body.get('howmany1'),'521');assert.match(proof,/paid by kHub/);
});

test('insufficient kHub operating funds defer Buy gifts without sending or spending buyer escrow',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);let attempted=false;
 f.worker.store.rpc=async(name,args)=>{
  if(name==='bot_charge_buy_gift'){f.calls.push([name,args]);return {authorized:true,payer:'bot'};}
  if(name==='bot_gift_wrapping_liabilities'){f.calls.push([name,args]);return {meat:'10000',items:{}};}
  if(name==='bot_defer_buy_delivery'){f.calls.push([name,args]);f.row.state='pending';return;}
  return original(name,args);
 };
 f.worker.transport.send=async(_,options)=>{try{await options.authorizeGift(50);}catch{throw new GiftDeliveryError('not_attempted');}attempted=true;};
 await f.worker.sendDelivery({...f.row,kind:'sale_item',dedupe_key:'buy-batch-items:fixture',item_id:1,quantity:521,meat:0});
 assert.equal(attempted,false);assert.equal(f.row.state,'pending');
 assert.equal(f.calls.some(([name])=>name==='bot_ack_delivery'),false);
 assert.equal(f.calls.filter(([name])=>name==='bot_defer_buy_delivery').length,1);
});


test('a worker with an old buyer-paid backend never sends a Buy gift charged to the buyer',async()=>{
 const f=fixture();const original=f.worker.store.rpc.bind(f.worker.store);let attempted=false;
 f.worker.store.rpc=async(name,args)=>{
  if(name==='bot_charge_buy_gift')return {authorized:true,payer:'buyer'};
  if(name==='bot_defer_buy_delivery'){f.calls.push([name,args]);f.row.state='pending';return;}
  return original(name,args);
 };
 f.worker.transport.send=async(_,options)=>{await options.authorizeGift(50);attempted=true;};
 await f.worker.sendDelivery({...f.row,kind:'sale_item',dedupe_key:'buy-fill-items:old-backend',item_id:1,quantity:521,meat:0});
 assert.equal(attempted,false);assert.equal(f.row.state,'pending');
 assert.equal(f.calls.filter(([name])=>name==='bot_defer_buy_delivery').length,1);
});

 test('a failed closet alert never blocks funded auction work',async()=>{
    const f=fixture();const rpc=f.worker.store.rpc;
    f.worker.store.rpc=async(name,args)=>{
        if(name==='bot_inspect')return{attention:[],closetIsolationVersion:1,closetAttention:[{id}]};
        if(name==='bot_isolate_closet_transfers')throw Error('Notice unavailable');
        return rpc(name,args);
    };
    await f.worker.cycle();assert.ok(f.calls.some(([name])=>name==='send'));assert.ok(f.calls.some(([name])=>name==='delete'));
});

test('confirmed ordinary KMail refusals trigger one gift fallback with identical assets',async()=>{
    for(const regular of [
        '<center>Legacy of Loathing players can only receive food, booze, potions, combat and usable items</center>',
        '<table><tr><td>Results:Legacy of Loathing players can only receive food, booze, potions, combat and usable items</td></tr></table>Send a Message Back to Your Inbox',
        '<center>You cannot send this item.</center>',
        "<center>That player's mailbox is full.</center>",
    ]){
        const f=giftFixture({regular});
        await f.transport.send(f.row,f.options);
        assert.deepEqual(f.requests.map(r=>r.path),['sendmessage.php','town_sendgift.php']);
        assert.deepEqual(f.costs,[50]);
        const sent=f.requests[1].options.body;
        assert.equal(sent.get('towho'),'888');assert.equal(sent.get('whichitem1'),'908');
        assert.equal(sent.get('howmany1'),'2');assert.equal(sent.get('sendmeat'),'1000');
    }
});
test('failed fallback after a confirmed refusal holds for review without another send',async()=>{
    for(const gift of [Error('timeout'),'<td>Recipient cannot receive this package.</td>']){
        const f=giftFixture({regular:'<center>You cannot send this item.</center>',gift});
        await assert.rejects(f.transport.send(f.row,f.options),/Gift package outcome uncertain/);
        assert.equal(f.requests.length,2);assert.deepEqual(f.costs,[50]);
    }
});
