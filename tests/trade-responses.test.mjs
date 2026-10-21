import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeResponseStatus, tradeResponseSummary } from '../src/lib/tradeResponses.js';
import { mapAuction } from '../src/lib/auctions.js';
import { threadRoleStatus } from '../src/lib/supportThreads.js';

test('responses use clear labels with matching light badge and text colors', () => {
    for (const [response,label,color,background] of [
        [{},'Awaiting response','text-slate-500','border-slate-200 bg-slate-50'],
        [{reportExcluded:true},'Report dismissed','text-slate-500','border-slate-200 bg-slate-50'],
        [{reportedIncomplete:true},'Reported Incomplete','text-red-700','border-red-200 bg-red-50'],
        [{confirmedAt:'2026-10-20'},'Confirmed Complete','text-green-800','border-green-200 bg-green-50'],
        [{resolvedAt:'2026-10-20'},'Confirmed Complete','text-green-800','border-green-200 bg-green-50'],
    ]) assert.deepEqual(tradeResponseStatus(response),{label,color,background});
});

test('auction mapping keeps neutral completion separate from positive rating evidence', () => {
    const auction=mapAuction({id:'a',seller_resolved_at:'2026-10-20',seller_reported_incomplete:false,buyer_reported_incomplete:true},[]);
    assert.equal(auction.sellerResolvedAt,'2026-10-20');
    assert.equal(auction.sellerConfirmedAt,undefined);
    assert.equal(auction.sellerReportedIncomplete,false);
    assert.equal(auction.buyerReportedIncomplete,true);
});

test('admin-excluded reports use a neutral badge without implying completion', () => {
    const thread={auction:{seller:{}},messages:[{reporter_role:'seller',message_type:'trade_rating',negative_counted:false,feedback_withdrawn:false}]};
    assert.equal(threadRoleStatus(thread,'seller').label,'Report dismissed');
    thread.auction.seller.resolved_at='2026-10-20';
    assert.equal(threadRoleStatus(thread,'seller').label,'Confirmed Complete');
});

test('response summaries describe each combination without waiting on an existing response', () => {
    for (const [response, expected] of [
        [{confirmedComplete:true,otherReportedIncomplete:true},'You confirmed this trade as complete, but the other party reported it as incomplete.'],
        [{reportedIncomplete:true,otherConfirmedComplete:true},'You reported this trade as incomplete, but the other party confirmed it as complete.'],
        [{reportedIncomplete:true,otherReportedIncomplete:true},'Both you and the other party reported this trade as incomplete.'],
        [{confirmedComplete:true,otherConfirmedComplete:true},'Both you and the other party confirmed this trade as complete.'],
        [{confirmedComplete:true},'You confirmed this trade as complete. Awaiting the other party’s response.'],
        [{reportedIncomplete:true},'You reported this trade as incomplete. Awaiting the other party’s response.'],
        [{reportExcluded:true},'Your incomplete report was dismissed by an administrator.'],
        [{confirmedComplete:true,otherReportExcluded:true},'You confirmed this trade as complete. The other party’s incomplete report was dismissed by an administrator.'],
        [{reportedIncomplete:true,otherReportExcluded:true},'You reported this trade as incomplete. The other party’s incomplete report was dismissed by an administrator.'],
        [{},''],
    ]) assert.equal(tradeResponseSummary(response),expected);
    const neutral=tradeResponseSummary({confirmedComplete:true,resolvedIncomplete:true,otherReportedIncomplete:true});
    assert.match(neutral,/You confirmed this trade as complete, but the other party reported it as incomplete/);
    assert.match(neutral,/Your incomplete report was withdrawn/);
    assert.doesNotMatch(neutral,/no positive rating was added/i);
    assert.doesNotMatch(neutral,/Awaiting/);
});
