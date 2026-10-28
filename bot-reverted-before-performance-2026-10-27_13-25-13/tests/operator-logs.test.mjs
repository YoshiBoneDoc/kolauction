import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorLogs, assets, deliveryPurpose, failureBody, logMailFailure} from '../src/operator-logs.mjs';
import {EscrowWorker} from '../src/worker.mjs';
const mail={id:'42',sender_id:123456,sender_name:'Player',command:{type:'bid',auction_number:'1234'},meat:50000,items:[]};
test('receipt, acceptance and rejection are distinct, readable events; duplicate outcomes stay quiet',()=>{
    const lines=[], logger=createOperatorLogs(line=>lines.push(line));
    logger.received(mail);logger.received(mail);
    assert.deepEqual(lines,['[RECEIVED KMail 42] BID · Auction #1234 from Player (#123456): 50,000 Meat.']);
    logger.outcome(mail,'accepted');
    assert.equal(lines[1],'[BID ACCEPTED] Auction #1234 · Player (#123456) · KMail 42.');
    assert.ok(!lines[1].includes('leading')); // Could have accepted at a lower buyout and closed bidding.
    logger.outcome(mail,'duplicate');assert.equal(lines.length,2);
    logger.outcome({...mail,id:'43'},'Bidding is closed.');
    assert.match(lines[2],/^\[BID REJECTED\].*Bidding is closed\. Return of attached assets queued\./);
    logger.outcome({...mail,command:{type:'bid_help'}},'bid_help');
    assert.ok(lines.some(line=>/^\[BID HELP\].*no bid accepted/.test(line)));
});
test('logs never include verification tokens or raw mail; names and reasons cannot inject terminal lines',()=>{
    const lines=[],logger=createOperatorLogs(line=>lines.push(line));
    logger.received({...mail,sender_name:'Player\n\x1b[31mINJECT',command:{type:'verify',token:'private-verification-secret'},raw:{message:'private body'}});
    logger.outcome(mail,'Rejected.\nForged event');
    assert.ok(lines.every(line=>!/[\n\r\x1b]/.test(line)));
    assert.ok(!lines.join('').includes('private'));
    assert.ok(!lines.join('').includes('undefined'));
});
test('assets and purpose labels use safe existing metadata without exposing message bodies',()=>{
    assert.equal(assets(2222222),'2,222,222 Meat');
    assert.equal(assets(0,[{id:1,quantity:1000}]),'1,000 × seal-clubbing club');
    assert.equal(assets(0,[{id:99999999,quantity:1}]),'1 × item #99999999');
    assert.equal(deliveryPurpose({dedupe_key:'donation-thanks:42',kind:'notice'}),'donation acknowledgment');
    assert.equal(deliveryPurpose({dedupe_key:'outbid:42',kind:'refund'}),'outbid refund');
    assert.equal(deliveryPurpose({kind:'notice',message:'private credential'}),'notification');
});
function fixture(result,fail=false){
    const lines=[],calls=[];
    const store={rpc:async(name,args)=>{
        calls.push([name,args]);
        if(name==='bot_inspect')return {attention:[]};
        if(name==='bot_ingest_mail'){if(fail)throw Error('DB unavailable');return result;}
        if(name==='bot_liabilities')return {meat:'0',items:{}};
        if(name==='bot_mail_cleanup')return [];
        return null;
    }};
    const transport={snapshot:async()=>({meat:'1000000',items:{}}),inbox:async()=>[mail],closetSnapshot:async()=>({meat:'1000000',closetMeat:'0',items:{},closetItems:{}})};
    return {worker:new EscrowWorker({store,transport,live:true,log:line=>lines.push(line)}),lines,calls};
}
test('worker only reports acceptance after durable intake succeeds, with no new lookup queries',async()=>{
    for(const [result,fail] of [['accepted',false],['Bidding is closed.',false],['duplicate',false],[null,true]]){
        const f=fixture(result,fail);
        if(fail)await assert.rejects(f.worker.cycle(),/DB unavailable/);else await f.worker.cycle();
        assert.equal(f.lines.filter(line=>line.startsWith('[BID ACCEPTED]')).length,result==='accepted'?1:0);
        assert.equal(f.lines.filter(line=>line.startsWith('[BID REJECTED]')).length,result==='Bidding is closed.'?1:0);
        assert.equal(f.calls.filter(([name])=>name==='bot_ingest_mail').length,1);
        assert.ok(!f.calls.some(([name])=>/lookup/.test(name)));
    }
});

test('failure context includes actual sender and readable original text, with escaped terminal controls',()=>{
    const lines=[];
    logMailFailure(line=>lines.push(line),{...mail,raw:{message:'BID 1234 51000<br>Why not? &amp; hello\n\u001b[31m'}},'Intake rejected');
    assert.match(lines[0],/From Player \(#123456\)/);
    assert.match(lines[0],/BID 1234 51000/);
    assert.match(lines[0],/Why not\? & hello/);
    assert.ok(!/[\n\r\x1b]/.test(lines[0]));
    assert.equal(failureBody({message:'<p>Hello, my donation was sent in error.</p>'}),'Hello, my donation was sent in error.');
});
test('failure body redacts credentials before truncation, including malformed verification commands',()=>{
    for(const message of ['VERIFY secret-code','REGISTER anything','FORGOT LOGIN anything','password=secret-value','pwd=secret-value','token: secret-value']){
        const body=failureBody({message});
        assert.ok(!body.includes('secret-'),body);
    }
    assert.ok(!failureBody({...mail,command:{type:'credentials'},raw:{message:'something private'}}).includes('something private'));
    assert.match(failureBody({message:'x'.repeat(4100)}),/truncated/);
});
test('downstream failures retain original sender and body, not the outgoing recipient or credentials',()=>{
    const lines=[],logger=createOperatorLogs(line=>lines.push(line));
    logger.received({...mail,raw:{message:'BID 1234 51000 &lt; 60000'}});
    logger.failureForReceipt('42','Closet C-1033 failed');
    assert.match(lines.at(-1),/From Player \(#123456\).*BID 1234 51000 < 60000/);
    logger.failureForReceipt('old','Delivery failed');
    assert.match(lines.at(-1),/not cached.*inspect the receipt/);
});
