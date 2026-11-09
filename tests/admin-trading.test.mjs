import test from 'node:test';
import assert from 'node:assert/strict';
import { percentage, tradingRows, tradingTotal, compactMeat } from '../src/lib/adminTrading.js';
test('percentages use exact integer arithmetic, handle empty denominators and round to two decimals',()=>{
 assert.equal(percentage('0','0'),'—');assert.equal(percentage('1','3'),'33.33%');assert.equal(percentage('2','3'),'66.67%');assert.equal(percentage('42500','1000000'),'4.25%');
 assert.equal(percentage('100000000000000000000','200000000000000000000'),'50.00%');
});
test('only five component rows contribute; aggregate rows are not double-counted and Buy is excluded from method choice',()=>{
 const rows=tradingRows({breakdown:[{kind:'sell',method:'escrow',count:'2',meat:'100',fees:'5'},{kind:'sell',method:'direct',count:'1',meat:'300',fees:'0'},{kind:'buy',method:'escrow',count:'10',meat:'50',fees:'2'},{kind:'total',method:'escrow',count:'999',meat:'999',fees:'999'}]});
 assert.deepEqual(tradingTotal(rows),{count:13n,meat:450n,fees:7n});
 const choice=rows.filter(row=>row.kind!=='buy'),total=tradingTotal(choice),escrow=tradingTotal(choice.filter(row=>row.method==='escrow'));
 assert.equal(percentage(escrow.count,total.count),'66.67%');assert.equal(percentage(escrow.meat,total.meat),'25.00%');
 assert.deepEqual(tradingTotal(rows.filter(row=>row.kind==='bundle')),{count:0n,meat:0n,fees:0n});
});

test('compact Meat labels retain readable precision without converting large integers to floats', () => {
 for (const [value,label] of [['0','0'],['621300000','621.3m'],['3250000000','3.25b'],['33100','33.1k'],['10713936','10.71m'],['999','999'],['100000000000000000000','100000000t']]) assert.equal(compactMeat(value),label);
});
