import PropTypes from 'prop-types';
import { percentage, tradingRows, tradingTotal, compactMeat } from '../lib/adminTrading';
const exact = value => BigInt(value).toLocaleString('en-US');
function TradingChart({ kind, rows }) {
    const total = tradingTotal(rows);
    const maximum = rows.reduce((max,row) => BigInt(row.meat)>max ? BigInt(row.meat) : max,1n);
    return <section className="min-w-0 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="flex items-baseline justify-between gap-2"><h3 className="text-sm font-semibold capitalize text-gray-900">{kind} Auctions</h3></div>
        <div className="mt-4 grid grid-cols-2 gap-5">{rows.map(row => {
            const proportion = Number(BigInt(row.meat)*10000n/maximum)/100;
            const tiny = BigInt(row.meat)>0n && proportion<2;
            return <div key={row.method} className="min-w-0 text-center text-xs text-gray-600">
                <p className="text-sm font-medium tabular-nums" title={`${exact(row.meat)} Meat`}>{compactMeat(row.meat)}</p>
                <div className="mt-2 flex h-28 items-end justify-center border-b border-gray-200" title={`${exact(row.meat)} Meat${tiny ? ' · baseline marker, below 2% of scale' : ''}`}>
                    <div className={`w-14 max-w-full rounded-t ${row.method==='escrow' ? 'bg-blue-600' : 'bg-violet-400'}`} style={{height:BigInt(row.meat)===0n ? '0%' : `${tiny ? 2 : proportion}%`}} />
                </div>
                <p className="mt-3 font-medium capitalize text-gray-900">{row.method}</p>
                <p>{exact(row.count)} auctions · {percentage(row.count,total.count)} of trades</p>
                <p className="mt-1 text-gray-500">{percentage(row.meat,total.meat)} of volume</p>
            </div>;
        })}</div>
        <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-600">Fees: <span className="font-medium" title={`${exact(rows[0].fees)} Meat`}>{compactMeat(rows[0].fees)} Meat</span> ({percentage(rows[0].fees,rows[0].meat)})</p>
    </section>;
}
TradingChart.propTypes = {kind:PropTypes.string,rows:PropTypes.array};
export default function AdminTradingCharts({ transactions }) {
    const rows = tradingRows(transactions), buy = rows.find(row=>row.kind==='buy');
    const choice = rows.filter(row=>row.kind!=='buy'), choiceTotal=tradingTotal(choice), escrow=tradingTotal(choice.filter(row=>row.method==='escrow')), direct=tradingTotal(choice.filter(row=>row.method==='direct'));
    return <div className="my-3 space-y-3">
        <div className="grid gap-3 md:grid-cols-2">{['sell','bundle'].map(kind=><TradingChart key={kind} kind={kind} rows={rows.filter(row=>row.kind===kind)} />)}</div>
        <p className="text-xs text-gray-500">Charts use independent scales.</p>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-gray-200 px-3 py-2.5 text-xs text-gray-600">
            <span className="font-medium text-gray-900">Buy Orders <span className="font-normal text-gray-500">· Escrow only</span></span>
            <span><span title={`${exact(buy.meat)} Meat`}>{compactMeat(buy.meat)}</span> traded · {exact(buy.count)} fulfillments · <span title={`${exact(buy.fees)} Meat`}>{compactMeat(buy.fees)}</span> fees ({percentage(buy.fees,buy.meat)})</span>
        </div>
        <div className="pt-1 text-xs text-gray-500">
            <p className="mb-2">Sell + Bundle method choice</p>
            <div className="grid gap-3 sm:grid-cols-2">{[['Escrow',escrow,'bg-blue-600'],['Direct',direct,'bg-violet-400']].map(([label,total,color]) => <div key={label} className="flex items-center gap-2">
                <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-sm ${color}`} />
                <p><span className="font-medium text-gray-900">{label}:</span> {percentage(total.count,choiceTotal.count)} of auctions · {percentage(total.meat,choiceTotal.meat)} of volume</p>
            </div>)}</div>
        </div>
    </div>;
}
AdminTradingCharts.propTypes={transactions:PropTypes.object.isRequired};
