import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLeaderboardValue, parseLeaderboards, readLeaderboards } from '../src/lib/leaderboards.js';
const fixture = () => ({ refreshed_at:'2026-11-13T12:00:00Z', volume:[{id:'one',name:'Player',rank:1,value:'9007199254740993123'}], trades:[],donors:[] });
test('leaderboard read preserves exact totals and performs one bounded RPC', async () => {
    let calls=0;
    const result=await readLeaderboards({rpc(name){assert.equal(name,'read_leaderboards');calls++;return {data:fixture()};}});
    assert.equal(calls,1);assert.equal(result.volume[0].value,9007199254740993123n);
    assert.equal(compactLeaderboardValue(18420000000n),'18.42B');
    assert.equal(compactLeaderboardValue(308n),'308');
    assert.equal(compactLeaderboardValue(125000000n),'125M');
});
test('malformed or failed reads never fabricate leaderboard entries', async () => {
    for (const value of ['NaN','1.5','-1',1,'0']) {
        const data=fixture();data.volume[0].value=value;assert.throws(()=>parseLeaderboards(data));
    }
    const data=fixture();data.volume.push({...data.volume[0],rank:2});assert.throws(()=>parseLeaderboards(data));
    await assert.rejects(readLeaderboards({rpc:()=>({error:{message:'private details'}})}),/could not be loaded/);
});
