import test from 'node:test';
import assert from 'node:assert/strict';
import { compactLeaderboardValue, parseLeaderboards, readLeaderboards, searchLeaderboards } from '../src/lib/leaderboards.js';
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

test('personal totals preserve exact values and reject malformed data', () => {
    const data={...fixture(),personal:{volume:'9007199254740993123',trades:'0',donors:'500'}};
    assert.equal(parseLeaderboards(data).personal.volume,9007199254740993123n);
    assert.equal(parseLeaderboards(data).personal.trades,0n);
    data.personal.donors='-1';assert.throws(()=>parseLeaderboards(data));
});

test('remote search preserves overall ranks and bounded RPC arguments', async () => {
    const client={rpc(name,args){assert.equal(name,'search_leaderboards');assert.deepEqual(args,{p_category:'volume',p_search:'Player',p_offset:20});return {data:{rows:[{id:'p',name:'Player',value:'9007199254740993123',rank:47}],more:false}};}};
    const result=await searchLeaderboards(client,'volume',' Player ',20);
    assert.equal(result.rows[0].rank,47);assert.equal(result.rows[0].value,9007199254740993123n);
    await assert.rejects(searchLeaderboards({rpc:()=>({data:{rows:[{id:'x',name:'X',value:'1',rank:0}],more:false}})},'volume','X',0));
});

test('zero-activity search results require a null rank and preserve zero totals', async () => {
    const row={id:'zero',name:'Zero',value:'0',rank:null};
    const client={rpc:()=>({data:{rows:[row],more:false}})};
    assert.deepEqual((await searchLeaderboards(client,'volume','Zero',0)).rows,[{...row,value:0n}]);
    row.rank=1;
    await assert.rejects(searchLeaderboards(client,'volume','Zero',0),/zero-activity rank/);
    row.value='1';row.rank=null;
    await assert.rejects(searchLeaderboards(client,'volume','Zero',0),/search rank/);
});
