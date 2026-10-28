import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as router from 'react-router-dom';
import { createBugReportService } from '../src/lib/bugReports.js';

const { outputFiles } = buildSync({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { StaticRouter } from 'react-router-dom';
    import App from './src/App.jsx';
    import { UserContext } from './src/context/UserContext.jsx';
    import { AuctionsContext } from './src/context/AuctionsContext.jsx';
    export function render(path='/',user=null,signedInUserId=null) {
        return renderToStaticMarkup(<StaticRouter location={path}><UserContext.Provider value={{currentUser:user,signedInUserId}}>
            <AuctionsContext.Provider value={{auctions:[],isLoading:false,total:0}}><App/></AuctionsContext.Provider>
        </UserContext.Provider></StaticRouter>);
    }`,resolveDir:fileURLToPath(new URL('../',import.meta.url)),loader:'jsx'},
    bundle:true,write:false,platform:'node',format:'cjs',packages:'external',jsx:'automatic',
    define:{'import.meta.env':'{}'},loader:{'.gif':'dataurl'},
});
const compiled={exports:{}};
const requireModule=createRequire(import.meta.url);
new Function('require','module','exports',outputFiles[0].text)(name=>name==='react-router-dom'?router:requireModule(name),compiled,compiled.exports);
const {render}=compiled.exports;

test('shared footers show the same destinations and mark the current page',()=>{
    for (const path of ['/', '/donate', '/report-a-bug', '/meet-the-creator', '/update-log']) {
        const footer=render(path).match(/<nav aria-label="Footer links"[\s\S]*?<\/nav>/)?.[0];
        assert.ok(footer, path);
        for (const [href,label] of [['/donate','Donate'],['/report-a-bug','Report a Bug'],['/meet-the-creator','Meet the Creator']]) {
            const link=[...footer.matchAll(/<a\b[^>]*>[^<]*<\/a>/g)].map(match=>match[0]).find(item=>item.includes(`href="${href}"`));
            assert.ok(link?.includes(`>${label}</a>`), `${path}: ${label}`);
            assert.equal(link.includes('aria-current="page"'), path===href, `${path}: ${href}`);
        }
    }
});

test('creator page displays all six creator photo slots while images load',()=>{
    const gallery=render('/meet-the-creator').match(/<section aria-label="Photo journal"[\s\S]*?<\/section>/)?.[0];
    assert.ok(gallery);
    for (const label of ['Casual group photo', 'Graduation photo', 'Operating room photo', 'Waterfront photo', 'Savannah photo', 'Yosemite photo']) assert.ok(gallery.includes(label), label);
    assert.doesNotMatch(gallery, /OFFICIAL APPROVAL/);
    assert.doesNotMatch(gallery, /<img\b/);
});

test('anonymous users get login/contact guidance, signed-in users get a private report form',()=>{
    const anonymous=render('/report-a-bug');
    assert.match(anonymous,/Log in/);
    assert.match(anonymous,/towho=3552305/);
    assert.doesNotMatch(anonymous,/<textarea|Send bug report|Open administrator bug inbox/);
    const signedIn=render('/report-a-bug',{id:'reporter'});
    assert.match(signedIn,/<textarea[^>]*maxLength="2000"/);
    assert.match(signedIn,/Send bug report/);
    assert.match(signedIn,/Reports are private to administrators/);
    assert.doesNotMatch(signedIn,/Open administrator bug inbox/);
});

test('Info support link opens the general support form with login guidance for guests',()=>{
    assert.match(render('/info'),/href="\/support"[^>]*>Submit a support ticket/);
    const guest=render('/support');
    assert.match(guest,/Submit a Support Ticket/);
    assert.match(guest,/Log in/);
    assert.doesNotMatch(guest,/<textarea/);
    const signedIn=render('/support',{id:'reporter'});
    assert.match(signedIn,/How can we help\?/);
    assert.match(signedIn,/Submit support ticket/);
    assert.match(signedIn,/Support tickets are private to administrators/);
    assert.doesNotMatch(signedIn,/What went wrong|how to reproduce|Send bug report/);
});

test('general support submits text and a stable key to its dedicated server route',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:{reference:'B-1002'}};}});
    assert.equal((await service.submitSupportTicket('request-id','  Please help with my account.  ')).reference,'B-1002');
    assert.deepEqual(calls,[['submit_support_ticket',{p_request_id:'request-id',p_body:'Please help with my account.'}]]);
    for(const body of ['short','x'.repeat(2001)]) await assert.rejects(service.submitSupportTicket('id',body),/10 to 2,000/);
    assert.equal(calls.length,1);
    await assert.rejects(createBugReportService({async rpc(){return {data:{}};}}).submitSupportTicket('id','Please help with my account.'),/retry/);
});

test('administrator route never embeds cached private reports before authentication/authorization',()=>{
    assert.match(render('/admin/bug-reports'),/Log in.*administrator account/);
    const signedIn=render('/admin/bug-reports',{id:'normal'});
    assert.match(signedIn,/Loading private messages/);
    assert.doesNotMatch(signedIn,/Reply by KMail|Mark resolved/);
});

test('submission trims and sends only text and a stable retry key, never sender/recipient authority',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:{reference:'B-1001',notification:'queued'}};}});
    assert.equal((await service.submit('request-id','  The preview did not open.  ')).reference,'B-1001');
    await service.submit('request-id','The preview did not open.');
    assert.deepEqual(calls,[['submit_bug_report',{p_request_id:'request-id',p_body:'The preview did not open.'}],['submit_bug_report',{p_request_id:'request-id',p_body:'The preview did not open.'}]]);
});

test('invalid descriptions do not reach the backend, and network failure preserves a retryable result',async()=>{
    let calls=0;
    const service=createBugReportService({async rpc(){calls++;return {error:{code:'PGRST202',message:'private database details'}};}});
    for(const body of [' ','short','x'.repeat(2001)])await assert.rejects(service.submit('id',body),/10 to 2,000/);
    assert.equal(calls,0);
    await assert.rejects(service.submit('id','A valid report description.'),/temporarily unavailable/);
    await assert.rejects(createBugReportService({async rpc(){return {data:{unexpected:true}};}}).submit('id','A valid report description.'),/Please retry/);
});

test('admin reads and status changes use server-checked RPCs and expose safe denied/error messages',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return name==='khub_is_administrator'?{data:true}:name==='read_bug_report_inbox'?{data:{reports:[],total:'31'}}:{data:null};}});
    assert.equal(await service.isAdministrator(),true);
    assert.equal((await service.inbox('all',2)).total,31);
    await service.setStatus('report-id','resolved');
    assert.deepEqual(calls,[['khub_is_administrator',undefined],['read_bug_report_inbox',{p_status:'all',p_page:2}],['set_bug_report_status',{p_report_id:'report-id',p_status:'resolved'}]]);
    const denied=createBugReportService({async rpc(){return {error:{code:'42501',message:'private error'}};}});
    await assert.rejects(denied.inbox(),/Administrator access required/);
    await assert.rejects(denied.setStatus('id','open'),/Administrator access required/);
    const cooldown=createBugReportService({async rpc(){return {error:{code:'P0001',message:'Please wait a minute before sending another report.'}};}});
    await assert.rejects(cooldown.submit('id','A valid report description.'),/wait a minute/);
});

test('shared inbox has category tabs and keeps report submission in the shared footer', () => {
    const html=render('/admin/inbox',{id:'normal'});
    assert.match(html,/Administrator inbox/);
    assert.match(html,/Inbox categories/);
    assert.match(html,/Bug reports/);
    assert.match(html,/Trade queries/);
    assert.match(html,/Ban appeals/);
    assert.match(html,/Other/);
    const main=html.match(/<main\b[\s\S]*?<\/main>/)?.[0];
    assert.ok(main);
    assert.doesNotMatch(main,/href="\/report-a-bug"|Open administrator bug inbox/);
    assert.match(html,/href="\/report-a-bug"[^>]*>Report a Bug/);
    assert.doesNotMatch(render('/',{id:'normal'}),/href="\/admin\/inbox"/);
});

test('shared inbox sends category and pagination to the server and audits category updates',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return name==='read_support_inbox'?{data:{reports:[],total:21}}:{data:null};}});
    assert.equal((await service.supportInbox('appeal','all',2)).total,21);
    await service.setCategory('report-id','trade');
    assert.deepEqual(calls,[['read_support_inbox',{p_category:'appeal',p_status:'all',p_page:2}],['set_support_category',{p_report_id:'report-id',p_category:'trade'}]]);
    const denied=createBugReportService({async rpc(){return {error:{code:'42501'}};}});
    await assert.rejects(denied.supportInbox(),/Administrator access required/);
    await assert.rejects(denied.setCategory('id','other'),/Administrator access required/);
});

test('wall appeal link opens the private appeal form, including for restricted signed-in sessions',()=>{
    assert.match(render('/wall-of-shame'),/href="\/submit-appeal"[^>]*>Submit an appeal/);
    assert.doesNotMatch(render('/wall-of-shame'),/KMail teres minor.*to appeal/);
    assert.match(render('/submit-appeal'),/Log in to appeal/);
    const signedIn=render('/submit-appeal',{id:'player'});
    assert.match(signedIn,/<textarea[^>]*maxLength="2000"/);
    assert.match(signedIn,/Submit appeal/);
    const restricted=render('/submit-appeal',null,'restricted-player');
    assert.match(restricted,/<textarea/);
    assert.doesNotMatch(restricted,/Log in to appeal/);
});

test('appeals submit a stable request key and text without client identity or category claims',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:{reference:'B-1234'}};}});
    await service.submitAppeal('retry-id','  Please review this ban.  ');
    await service.submitAppeal('retry-id','Please review this ban.');
    assert.deepEqual(calls,Array(2).fill(['submit_ban_appeal',{p_request_id:'retry-id',p_body:'Please review this ban.'}]));
    await assert.rejects(service.submitAppeal('id','short'),/describe your appeal/);
});

test('trade reports send the auction and stable retry key without allowing client-supplied identities',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:{reference:'B-1234'}};}});
    await service.submitTradeReport('retry-id','auction-id','  I did not receive the items.  ');
    assert.deepEqual(calls,[['submit_trade_report',{p_request_id:'retry-id',p_auction_id:'auction-id',p_body:'I did not receive the items.'}]]);
    await service.submitTradeReport('silent','auction','');
    assert.deepEqual(calls.at(-1),['submit_trade_report',{p_request_id:'silent',p_auction_id:'auction',p_body:''}]);
    await assert.rejects(service.submitTradeReport('id','auction','x'.repeat(2001)),/optional explanation/);
});

test('administrator rating review sends a counted flag and audited reason',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:null};}});
    await service.reviewTradeRating('report',false,'  The report describes a different player.  ');
    assert.deepEqual(calls,[['review_trade_rating',{p_report_id:'report',p_counted:false,p_reason:'The report describes a different player.'}]]);
    await assert.rejects(service.reviewTradeRating('report',false,''),/review reason/);
    const denied=createBugReportService({async rpc(){return {error:{code:'42501'}};}});
    await assert.rejects(denied.reviewTradeRating('report',true,'Reviewed evidence.'),/Administrator access required/);
});

test('administrators can request missing rating notices for one auction without client recipient overrides',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:{queued:2,remaining:0}};}});
    assert.deepEqual(await service.notifyAuctionRatings('auction-id'),{queued:2,remaining:0});
    assert.deepEqual(calls,[['notify_auction_ratings',{p_auction_id:'auction-id'}]]);
    const denied=createBugReportService({async rpc(){return {error:{code:'42501'}};}});
    await assert.rejects(denied.notifyAuctionRatings('auction-id'),/Administrator access required/);
});

test('author withdrawal and separate trade queries never accept caller-supplied rating targets',async()=>{
    const calls=[];
    const service=createBugReportService({async rpc(name,params){calls.push([name,params]);return {data:name==='submit_trade_query'?{reference:'B-1234'}:null};}});
    await service.withdrawTradeRating('auction');
    await service.submitTradeQuery('request','auction','Please review this trade concern.');
    assert.deepEqual(calls,[['withdraw_trade_rating',{p_auction_id:'auction'}],['submit_trade_query',{p_request_id:'request',p_auction_id:'auction',p_body:'Please review this trade concern.'}]]);
});
