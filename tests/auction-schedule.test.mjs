import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {customAuctionEnd,localDateTimeInput,MAX_AUCTION_DURATION_MS} from '../src/lib/auctionSchedule.js';

test('custom ending dates convert local wall time into an absolute UTC timestamp with a 30-day bound',()=>{
    const now=Date.now();const local=localDateTimeInput(now+3600000);const result=customAuctionEnd(local,now);
    assert.equal(new Date(result).getTime(),new Date(local).getTime());
    for(const value of ['', 'not a date','2026-02-30T12:00',localDateTimeInput(now-60000),localDateTimeInput(now+MAX_AUCTION_DURATION_MS+86400000)])assert.throws(()=>customAuctionEnd(value,now));
});
test('DST-skipped local times reject rather than silently moving the selected deadline',()=>{
    const code=`import {customAuctionEnd} from './src/lib/auctionSchedule.js';
        const now=Date.parse('2027-03-01T00:00:00Z');
        try{customAuctionEnd('2027-03-14T02:30',now);process.exit(1);}catch(e){if(!e.message.includes('valid ending'))throw e;}
        if(customAuctionEnd('2027-03-14T03:30',now)!=='2027-03-14T07:30:00.000Z')process.exit(2);`;
    execFileSync(process.execPath,['--input-type=module','-e',code],{cwd:new URL('../',import.meta.url),env:{...process.env,TZ:'America/New_York'}});
});
