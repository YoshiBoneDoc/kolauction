import { feeLabel } from './fee-display.mjs';
const amount = value => BigInt(value).toLocaleString('en-US');
// Player-supplied names should never inject terminal control sequences/lines.
const name = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');

export function financialSummary(report) {
    const { donations: d, sales: s } = report;
    return [
        'kHub lifetime financial report',
        '',
        `Donations received: ${amount(d.receipts)} messages`,
        `Donated Meat: ${amount(d.meat)} Meat`,
        `Gift packages received: ${amount(d.gift_packages)} (contents not inspected)`,
        'Donated items:',
        ...(d.items.length ? d.items.map(item => `  ${name(item.name)} × ${amount(item.quantity)}`) : ['  None recorded']),
        '',
        `Completed sales: ${amount(s.completed)}`,
        `Total auction value traded: ${amount(s.trade_meat)} Meat`,
        `${feeLabel(s.commission_meat,s.trade_meat,false)} earned: ${amount(s.commission_meat)} Meat`,
        `Seller proceeds: ${amount(s.seller_proceeds_meat)} Meat`,
        '',
        'Trade value includes commission; refunds, active auctions and unsold lots are excluded.',
        ...(report.buy_orders ? ['', `Buy-order fulfillments: ${amount(report.buy_orders.fulfillments)}`, `Buy-order purchases: ${amount(report.buy_orders.purchase_meat)} Meat`, `Buy-order ${feeLabel(report.buy_orders.commission_meat,report.buy_orders.purchase_meat)}: ${amount(report.buy_orders.commission_meat)} Meat`, `Buy-order escrow remaining: ${amount(report.buy_orders.held_meat)} Meat`, `Historical buyer packaging charges: ${amount(report.buy_orders.gift_meat || 0)} Meat`, ...(report.buy_orders.bot_packaging_meat != null ? [`kHub-paid Buy gift packaging: ${amount(report.buy_orders.bot_packaging_meat)} Meat`] : [])] : []),
        'Lifetime records, not current inventory/closet balances. Item donations have no estimated Meat value.',
    ].join('\n');
}

export function financialHistory(report, page) {
    const lines = [`kHub ${report.kind} — page ${page}`, ''];
    for (const r of report.records) {
        if (report.kind === 'donations') {
            lines.push(`${name(r.received_at)} | ${name(r.sender_name || 'Player')} (#${r.sender_id}) | KMail ${r.mail_id}`);
            lines.push(r.kind === 'gift_package' ? '  Gift package (contents not inspected)' : `  ${amount(r.meat)} Meat`);
            for (const item of r.items) lines.push(`  ${name(item.name)} × ${amount(item.quantity)}`);
        } else {
            lines.push(`${name(r.completed_at)} | Auction #${r.auction_number} | ${name(r.item)} × ${amount(r.quantity)}`);
            lines.push(`  Sale: ${amount(r.sale_meat)} Meat | ${feeLabel(r.commission_meat,r.sale_meat,r.fee_policy !== 'flat')}: ${amount(r.commission_meat)} Meat | Seller: ${amount(r.seller_proceeds_meat)} Meat`);
        }
        lines.push('');
    }
    if (!report.records.length) lines.push('No records on this page.');
    if (report.records.length === report.limit) lines.push(`Next page: npm run stats -- ${report.kind} ${page + 1}`);
    return lines.join('\n');
}
