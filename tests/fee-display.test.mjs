import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveFeePercent, feeLabel } from '../src/lib/feeDisplay.js';

test('effective fee percentages use actual fee over purchase value and trim trailing zeros',()=>{
    for(const [fee,price,expected] of [[410000,10000000,'4.1%'],[420000,10000000,'4.2%'],[3110000,100000000,'3.11%'],[21110000,1000000000,'2.111%'],[1,6,'16.6667%'],[0,1,'0%'],[0,0,'0%'],[1,10000000000000,'<0.0001%']])assert.equal(effectiveFeePercent(fee,price),expected);
    assert.equal(effectiveFeePercent('9007199254740993','180143985094819860'),'5%');
    assert.equal(feeLabel(410000,10000000),'Tiered Fee (4.1%)');
    assert.equal(feeLabel(750,10000,false),'Fee (7.5%)');
    assert.throws(()=>effectiveFeePercent(-1,100),/nonnegative/);
});
