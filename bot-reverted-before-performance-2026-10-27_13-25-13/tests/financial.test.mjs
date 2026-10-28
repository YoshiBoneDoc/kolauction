import test from 'node:test';
import assert from 'node:assert/strict';
import { financialSummary, financialHistory } from '../src/financial.mjs';

test('financial summary preserves large lifetime amounts and distinguishes trade value from income', () => {
    const result = financialSummary({ donations: { receipts: '2', meat: '9007199254740993', gift_packages: '1',
        items: [{ name: 'Mr. Accessory\n\x1b[31m', quantity: '9007199254740993' }] },
        sales: { completed: '1', trade_meat: '10000', commission_meat: '750', seller_proceeds_meat: '9250' } });
    assert.match(result, /Donated Meat: 9,007,199,254,740,993 Meat/);
    assert.match(result, /Total auction value traded: 10,000 Meat/);
    assert.match(result, /Fee \(7.5%\) earned: 750 Meat/);
    assert.match(result, /Seller proceeds: 9,250 Meat/);
    assert.match(result, /contents not inspected/);
    assert.match(result, /not current inventory\/closet balances/);
    assert.ok(!result.includes('\x1b'));
});

test('empty reports and end-of-history pages are explicit', () => {
    assert.match(financialSummary({ donations: { receipts: '0', meat: '0', gift_packages: '0', items: [] },
        sales: { completed: '0', trade_meat: '0', commission_meat: '0', seller_proceeds_meat: '0' } }), /None recorded/);
    assert.match(financialHistory({ kind: 'sales', records: [], limit: 20 }, 2), /No records on this page/);
});

test('donation history includes provenance and gift limits without exposing raw mail', () => {
    const result = financialHistory({ kind: 'donations', limit: 1, records: [{ received_at: '2026-10-19',
        sender_name: 'Player\nName', sender_id: '777', mail_id: '1000', kind: 'gift_package', meat: '0', items: [] }] }, 1);
    assert.match(result, /Player Name \(#777\) \| KMail 1000/);
    assert.match(result, /Gift package \(contents not inspected\)/);
    assert.match(result, /Next page: npm run stats -- donations 2/);
});

test('sale history shows the actual commission and seller proceeds per auction', () => {
    const result = financialHistory({ kind: 'sales', limit: 20, records: [{ completed_at: '2026-10-19',
        auction_number: '1001', item: 'Mr. Accessory', quantity: '2', sale_meat: '10000', commission_meat: '0', seller_proceeds_meat: '10000' }] }, 1);
    assert.match(result, /Auction #1001 \| Mr. Accessory × 2/);
    assert.match(result, /Sale: 10,000 Meat \| Tiered Fee \(0%\): 0 Meat \| Seller: 10,000 Meat/);
});


test('buy-order reports keep buyer fees separate from full seller payments',()=>{
 const summary=financialSummary({donations:{receipts:'0',meat:'0',gift_packages:'0',items:[]},sales:{completed:'0',trade_meat:'0',commission_meat:'0',seller_proceeds_meat:'0'},buy_orders:{fulfillments:'2',purchase_meat:'20000',commission_meat:'1000',held_meat:'16800'}});
 assert.match(summary,/Buy-order purchases: 20,000 Meat/);assert.match(summary,/Buy-order Tiered Fee \(5%\): 1,000 Meat/);assert.match(summary,/Buy-order escrow remaining: 16,800 Meat/);
 const history=financialHistory({kind:'buy-orders',limit:1,records:[{completed_at:'2026-10-22',auction_number:'1200',item:'Item',quantity:'20',sale_meat:'4000',commission_meat:'200',seller_proceeds_meat:'4000'}]},1);
 assert.match(history,/Sale: 4,000 Meat \| Tiered Fee \(5%\): 200 Meat \| Seller: 4,000 Meat/);assert.match(history,/npm run stats -- buy-orders 2/);
});


test('Buy packaging paid by kHub is reported separately from commissions and historical buyer charges',()=>{
 const text=financialSummary({donations:{receipts:'0',meat:'0',gift_packages:'0',items:[]},sales:{completed:'0',trade_meat:'0',commission_meat:'0',seller_proceeds_meat:'0'},buy_orders:{fulfillments:'2',purchase_meat:'20000',commission_meat:'1000',held_meat:'16800',gift_meat:'50',bot_packaging_meat:'150'}});
 assert.match(text,/Buy-order Tiered Fee \(5%\): 1,000 Meat/);
 assert.match(text,/Historical buyer packaging charges: 50 Meat/);
 assert.match(text,/kHub-paid Buy gift packaging: 150 Meat/);
});
