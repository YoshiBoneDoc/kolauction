import test from 'node:test';
import assert from 'node:assert/strict';
import {mailResponseDiagnostic, confirmedMailRejection} from '../src/mail-diagnostics.mjs';
import {KolTransport} from '../src/transport.mjs';
import {MailDeliveryError} from '../src/protocol.mjs';
test('server diagnostics retain error text, omit echoed mail and never expose account mail',()=>{
    const d=mailResponseDiagnostic('<center>You do not have enough items.</center><blockquote>private submitted body</blockquote><form><input value="private-token"></form>',{display_message:'private submitted body'},200);
    assert.equal(d.httpStatus,200);assert.ok(d.signals.includes('missing_items'));
    assert.match(d.serverText,/enough items/);assert.ok(!JSON.stringify(d).includes('private'));
    const c=mailResponseDiagnostic('<center>temporary password ABCsecret123</center>',{dedupe_key:'account-credentials:42'},200);
    assert.ok(!JSON.stringify(c).includes('ABCsecret123'));
});
test('failed sends record a safe response diagnostic and never issue a second transfer',async()=>{
    let writes=0;
    const transport=new KolTransport('kHub','',{session:async(_path,opts)=>{writes++;opts.onResponse({response:{status:200}});return '<center>You do not have enough items.</center>';}});
    transport.identity=async()=>{};
    await assert.rejects(transport.send({id:'example',recipient_id:123,item_id:4104,quantity:1,meat:0,message:'Return marble'}),e=>{
        assert.ok(e instanceof MailDeliveryError);assert.match(e.evidence,/missing_items/);assert.equal(e.diagnostic.httpStatus,200);return true;
    });
    assert.equal(writes,1);
});

test('only explicit unquoted server refusals authorize a fallback',()=>{
    const rejection='Legacy of Loathing players can only receive food, booze, potions, combat and usable items';
    assert.equal(confirmedMailRejection('<center>'+rejection+'</center>'),'Legacy of Loathing restriction');
    for(const html of ['<blockquote><center>'+rejection+'</center></blockquote>', '<form><center>'+rejection+'</center></form>', '<pre>'+rejection+'</pre>', '<center>I quoted: '+rejection+'</center>', '<center>Something went wrong.</center>', '<html>Login required</html>']) assert.equal(confirmedMailRejection(html),null);
});
