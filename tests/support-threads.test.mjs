import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as router from 'react-router-dom';
import { createBugReportService } from '../src/lib/bugReports.js';
import { threadKey, threadRoleStatus, formatSupportTimestamp, supportTimeline } from '../src/lib/supportThreads.js';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import SupportThread from './src/components/SupportThread.jsx';
    export function render(thread, expanded=false) {
        return renderToStaticMarkup(<StaticRouter location="/admin/inbox"><SupportThread
            thread={thread} expanded={expanded} onToggle={()=>{}} pending={false}
            onCategoryChange={()=>{}} onStatusChange={()=>{}} onUpdated={()=>{}} /></StaticRouter>);
    }`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic',
    define: { 'import.meta.env': '{}' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;

const message = { id:'report-1',reference:'B-1003',category:'trade',body:'The buyer has not paid.',status:'open',
    created_at:'2026-10-20T12:00:00Z',reporter_username:'Seller',reporter_role:'seller',
    reporter_kol_id:111,message_type:'trade_rating',negative_counted:true,feedback_withdrawn:false,target_username:'Buyer' };
const thread = { id:'auction-1',is_trade:true,updated_at:'2026-10-20T13:00:00Z',status:'open',
    auction:{id:'auction-1',number:1013,item:'asbestos ore',quantity:2,image:'/ore.gif',escrow:false,
        seller:{name:'Seller',player_id:111,confirmed_at:null},buyer:{name:'Buyer',player_id:222,confirmed_at:'2026-10-20'}},
    messages:[message,{...message,id:'query-1',reference:'B-1004',body:'Please review the exchange.',message_type:'trade_query',negative_counted:null}] };

test('appeal summaries load ban details in the header without adding controls to expanded messages', () => {
    const appeal = { ...thread, id: 'appeal-1', is_trade: false, auction: null,
        messages: [{ ...message, id: 'appeal-1', category: 'appeal', message_type: 'general' }] };
    assert.match(render(appeal), /Loading ban details/);
    assert.match(render({ ...appeal, status: 'resolved' }, true), /Loading ban details/);
    assert.doesNotMatch(render(thread, true), /Appeal account controls/);
    assert.doesNotMatch(render({ ...appeal, messages: [{ ...appeal.messages[0], category: 'other' }] }, true), /Appeal account controls/);
    const expanded = render(appeal, true);
    assert.ok(expanded.indexOf('Appeal account controls') < expanded.indexOf('id="body-message-appeal-1"'));
    assert.doesNotMatch(expanded, /Manage ban|Hide ban controls|Refresh ban details/);
    assert.doesNotMatch(render(appeal, true), /Change ban|Lift ban|Permanently banned/);
});

test('ban events and appeal replies share newest-first ordering without truncating their full text', () => {
    const appeal = { ...thread, is_trade: false, auction: null,
        messages: [{ ...message, id: 'appeal', category: 'appeal', message_type: 'general', created_at: '2026-10-20T13:00:00Z' }] };
    const reason = 'Complete ban reason. '.repeat(40);
    const events = [
        { id: 'ban-event-1', action: 'issued', created_at: '2026-10-20T12:00:00Z', reason },
        { id: 'ban-event-2', action: 'removed', created_at: '2026-10-20T14:00:00Z', reason: 'Appeal accepted.' },
    ];
    const timeline = supportTimeline(appeal, events);
    assert.deepEqual(timeline.map(entry => entry.id), ['ban-event-2', 'appeal', 'ban-event-1']);
    assert.equal(timeline[2].reason, reason);
    assert.equal(timeline[0].message_type, 'account_ban_event');
    assert.equal(appeal.messages.length, 1);
});

test('collapsed trade rows show item, participants and responses without message or delivery clutter', () => {
    const html=render(thread);
    assert.match(html,/aria-expanded="false" aria-controls="body-trade-auction-1"/);
    assert.match(html,/<img src="\/ore.gif" alt="asbestos ore"/);
    assert.match(html,/2 × asbestos ore/);
    assert.match(html,/Auction #1013 · Open · 2 messages/);
    assert.match(html,/Seller:|Seller<\/span>/);
    assert.match(html,/Reported Incomplete/);
    assert.match(html,/Buyer<\/span>/);
    assert.match(html,/Confirmed Complete/);
    assert.match(html,/Change type/);
    assert.match(html,/<time[^>]*class="block whitespace-nowrap[^>]*>10\/20\/2026, \d{1,2}:\d{2} [AP]M<\/time>/);
    assert.ok(html.indexOf('>Trade query</p>') < html.indexOf('>Change type</button>'));
    assert.doesNotMatch(html,/<select|The buyer has not paid|Please review the exchange|Exclude incomplete report|Mark resolved|Reply by KMail|KMail to teres Minor|Rated player/);
});

test('inbox timestamps omit seconds and message types reflect recategorization or mixed threads', () => {
    assert.match(formatSupportTimestamp('2026-10-20T21:10:54'),/^10\/20\/2026, 9:10 PM$/);
    const bug=render({...thread,messages:thread.messages.map(message=>({...message,category:'bug'}))});
    assert.match(bug,/>Bug report<\/p>/);
    const mixed=render({...thread,messages:[message,{...thread.messages[1],category:'other'}]});
    assert.match(mixed,/>Mixed types<\/p>/);
});

test('expanded trades put both messages and independent feedback reviews in one timeline', () => {
    const both={...thread,messages:[message,{...message,id:'buyer-report',reference:'B-1005',reporter_username:'Buyer',reporter_role:'buyer',target_username:'Seller',body:'The items did not arrive.'},thread.messages[1]]};
    const html=render(both,true);
    assert.match(html,/aria-expanded="true" aria-controls="body-trade-auction-1"/);
    assert.match(html,/The buyer has not paid/);
    assert.match(html,/The items did not arrive/);
    assert.match(html,/Please review the exchange/);
    assert.equal((html.match(/>Exclude incomplete report<\/button>/g)||[]).length,2);
    const sellerControls=html.split('aria-label="Seller trade response"')[1].split('</section>')[0];
    const buyerControls=html.split('aria-label="Buyer trade response"')[1].split('</section>')[0];
    assert.match(sellerControls,/aria-label="Exclude incomplete report from Seller’s profile"/);
    assert.match(sellerControls,/Incomplete report on <strong>Seller&#x27;s profile<\/strong>/);
    assert.match(sellerControls,/Reported by the buyer · B-1005/);
    assert.match(buyerControls,/aria-label="Exclude incomplete report from Buyer’s profile"/);
    assert.match(buyerControls,/Reported by the seller · B-1003/);
    assert.ok(html.indexOf('>Exclude incomplete report</button>') < html.indexOf('The buyer has not paid'));
    assert.doesNotMatch(html,/Feedback for|Counted\./);
    assert.equal((html.match(/Mark resolved/g)||[]).length,1);
    assert.ok(html.indexOf('Mark resolved')>html.indexOf('Please review the exchange'));
    assert.match(html,/href="\/auction\/auction-1"/);
    assert.match(html,/Internal reference/);
    assert.doesNotMatch(html,/Reply by KMail|KMail to teres Minor|Rated player|Send missing rating notices/);
});

test('withdrawn feedback stays withdrawn and cannot be restored or reopened on its own', () => {
    const withdrawn={...thread,status:'resolved',resolution_kind:'participant_resolved',messages:[{...message,status:'resolved',resolution_kind:'participant_resolved',negative_counted:false,feedback_withdrawn:true}]};
    const html=render(withdrawn,true);
    assert.match(html,/Resolved by reporter/);
    assert.match(html,/Incomplete report withdrawn from <strong>Buyer&#x27;s profile<\/strong>/);
    assert.doesNotMatch(html,/Exclude incomplete report|Restore incomplete report|Reopen conversation|Mark resolved/);
});

test('a seller report places removal on the buyer profile, not on the reporting seller', () => {
    const html=render(thread,true);
    const sellerControls=html.split('aria-label="Seller trade response"')[1].split('</section>')[0];
    const buyerControls=html.split('aria-label="Buyer trade response"')[1].split('</section>')[0];
    assert.doesNotMatch(sellerControls,/Exclude incomplete report|Incomplete report on/);
    assert.match(buyerControls,/aria-label="Exclude incomplete report from Buyer’s profile"/);
    assert.match(buyerControls,/Incomplete report on <strong>Buyer&#x27;s profile<\/strong>/);
    const excluded=render({...thread,messages:[{...message,negative_counted:false}]},true);
    assert.match(excluded,/Incomplete report excluded from <strong>Buyer&#x27;s profile<\/strong>/);
    assert.match(excluded,/aria-label="Restore incomplete report on Buyer’s profile"/);
    assert.doesNotMatch(excluded,/aria-label="Exclude incomplete report/);
});

test('standalone messages keep their own identity and no auction or rating controls', () => {
    const bug={...thread,id:'bug-1',is_trade:false,auction:null,messages:[{...message,category:'bug',reporter_role:null,message_type:'general',negative_counted:null}]};
    assert.notEqual(threadKey(bug),threadKey({...bug,is_trade:true}));
    const html=render(bug,true);
    assert.match(html,/B-1003 · Open · 1 message/);
    assert.match(html,/Bug reports/);
    assert.match(html,/Mark resolved/);
    assert.doesNotMatch(html,/View auction|Internal reference|Feedback for/);
});

test('summary statuses distinguish each party and ignore queries, withdrawn and excluded feedback', () => {
    assert.equal(threadRoleStatus(thread,'seller').label,'Reported Incomplete');
    assert.equal(threadRoleStatus(thread,'buyer').label,'Confirmed Complete');
    assert.equal(threadRoleStatus({...thread,messages:[{...message,negative_counted:false}]},'seller').label,'Report dismissed');
    for (const changes of [{message_type:'trade_query'},{feedback_withdrawn:true}]) {
        assert.equal(threadRoleStatus({...thread,messages:[{...message,...changes}]},'seller').label,'Awaiting response');
    }
});

test('thread reads and mutations pass only group identity and audited changes to administrator RPCs', async () => {
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:name==='read_support_threads'?{threads:[thread],total:'21'}:null};}});
    const data=await service.supportThreads('trade','open',2);
    assert.equal(data.total,21);
    assert.equal(data.threads[0].messages.length,2);
    await service.updateSupportThread('auction-1',true,{status:'resolved'});
    await service.updateSupportThread('bug-1',false,{category:'other'});
    assert.deepEqual(calls,[
        ['read_support_threads',{p_category:'trade',p_status:'open',p_page:2}],
        ['update_support_thread',{p_thread_id:'auction-1',p_is_trade:true,p_status:'resolved',p_category:null}],
        ['update_support_thread',{p_thread_id:'bug-1',p_is_trade:false,p_status:null,p_category:'other'}],
    ]);
    const denied=createBugReportService({async rpc(){return {error:{code:'42501'}};}});
    await assert.rejects(denied.supportThreads(),/Administrator access required/);
    await assert.rejects(denied.updateSupportThread('id',true,{status:'resolved'}),/Administrator access required/);
    const broken=createBugReportService({async rpc(){return {data:{reports:[],total:1}};}});
    await assert.rejects(broken.supportThreads(),/inbox could not be loaded/);
});


test('silent reports get a distinct green withdrawal update at the actual withdrawal time', () => {
    const withdrawnAt = '2026-10-21T15:00:00Z';
    const report = { ...message, body: 'No explanation provided.', status: 'resolved', resolution_kind: 'participant_resolved', feedback_withdrawn: true, withdrawn_at: withdrawnAt, withdrawal_confirmed_complete: true, negative_counted: false };
    const resolved = { ...thread, status: 'resolved', resolution_kind: 'participant_resolved', updated_at: withdrawnAt, auction: { ...thread.auction, status: 'awaiting_trade', seller: { ...thread.auction.seller, resolved_at: withdrawnAt } }, messages: [report] };
    const html = render(resolved, true);
    assert.match(html, /Auction #1013 · Resolved by reporter · 2 messages/);
    assert.match(html, /aria-label="Report withdrawal update"/);
    assert.match(html, /border-green-200 bg-green-50/);
    assert.match(html, /<strong>Seller<\/strong> withdrew their incomplete report and changed their response to <strong>Confirmed Complete<\/strong>/);
    assert.match(html, /dateTime="2026-10-21T15:00:00Z"|datetime="2026-10-21T15:00:00Z"/);
    assert.match(html, /System update · B-1003/);
    assert.equal((html.match(/aria-label="Report withdrawal update"/g) || []).length, 1);
    assert.doesNotMatch(html, /Both parties confirmed|trade was completed/);
    const collapsed = render(resolved);
    assert.match(collapsed, />Report withdrawn<\/span>/);
    assert.doesNotMatch(collapsed, /System update|changed their response/);
});

test('messages and withdrawal updates show newest first with one event per withdrawing party', () => {
    const reports = [
        { ...message, feedback_withdrawn: true, withdrawn_at: '2026-10-20T14:00:00Z', withdrawal_confirmed_complete: true },
        { ...message, id: 'buyer-report', reporter_username: 'Buyer', reporter_role: 'buyer', created_at: '2026-10-20T12:30:00Z', feedback_withdrawn: true, withdrawn_at: '2026-10-20T16:00:00Z', withdrawal_confirmed_complete: true },
        { ...thread.messages[1], created_at: '2026-10-20T15:00:00Z' },
    ];
    const resolved = { ...thread, messages: reports };
    assert.deepEqual(supportTimeline(resolved).map(entry => entry.id), ['withdrawal-buyer-report', 'query-1', 'withdrawal-report-1', 'buyer-report', 'report-1']);
    assert.deepEqual(supportTimeline(resolved).map(entry => entry.id), supportTimeline(resolved).map(entry => entry.id));
    assert.equal(reports.length, 3);
    const html = render(resolved, true);
    assert.equal((html.match(/aria-label="Report withdrawal update"/g) || []).length, 2);
    assert.match(html, />2 reports withdrawn<\/span>/);
    assert.ok(html.indexOf('withdrawal update') < html.indexOf('Please review the exchange'));
    assert.ok(html.indexOf('Please review the exchange') < html.lastIndexOf('withdrawal update'));
});

test('admin resolution/exclusion never creates a reporter withdrawal or completion event', () => {
    const closed = { ...thread, status: 'resolved', resolution_kind: 'administrator', messages: [{ ...message, status: 'resolved', resolution_kind: 'administrator', negative_counted: false }] };
    assert.equal(supportTimeline(closed).length, 1);
    assert.doesNotMatch(render(closed, true), /Report withdrawal update|changed their response|System update/);
    const legacy = { ...thread, messages: [{ ...message, feedback_withdrawn: true, withdrawn_at: '2026-10-20T14:00:00Z', withdrawal_confirmed_complete: false }] };
    const update = render(legacy, true).split('aria-label="Report withdrawal update"')[1].split('</section>')[0];
    assert.match(update, /withdrew their incomplete report/);
    assert.doesNotMatch(update, /changed their response|Confirmed Complete/);
});

test('free-text responses render under one poll question with individual authors and safely escaped bodies', () => {
    const pollThread={id:'poll-thread',is_trade:false,poll:{id:'poll-thread',question:'What could we improve?'},updated_at:'2026-10-23T12:00:00Z',status:'open',messages:[
        {...message,id:'one',category:'other',message_type:'poll_response',reporter_role:null,reporter_username:'First player',body:'Add <script>alert(1)</script>'},
        {...message,id:'two',category:'other',message_type:'poll_response',reporter_role:null,reporter_username:'Second player',body:'A second suggestion'},
    ]};
    const html=render(pollThread,true);
    assert.match(html,/Poll: What could we improve\?/);assert.match(html,/2 messages/);
    assert.match(html,/First player/);assert.match(html,/Second player/);assert.match(html,/Poll response/);
    assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
    assert.equal((html.match(/<article/g)||[]).length,1);
});
