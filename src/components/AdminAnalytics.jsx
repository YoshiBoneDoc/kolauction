import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';

const format = value => BigInt(value).toLocaleString('en-US');

const compact = value => {
    const amount = BigInt(value);
    for (const [scale, suffix] of [[1000000000000n, 't'], [1000000000n, 'b'], [1000000n, 'm'], [1000n, 'k']]) {
        if (amount >= scale) return `${(Number(amount * 100n / scale) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}${suffix}`;
    }
    return format(value);
};
const meat = value => <span title={`${format(value)} Meat`}>{compact(value)} Meat</span>;

function TransactionActivity({ transactions }) {
    if (!transactions) return <p className="mt-4 text-sm text-gray-500">Transaction breakdown unavailable. Apply the administrator transaction analytics migration.</p>;
    const rows = [['sell', 'escrow'], ['sell', 'direct'], ['buy', 'escrow'], ['bundle', 'escrow'], ['bundle', 'direct']].map(([kind, method]) => ({
        kind, method, count: '0', meat: '0', fees: '0',
        ...transactions.breakdown.find(row => row.kind === kind && row.method === method),
    }));
    const methods = ['escrow', 'direct'].map(method => rows.filter(row => row.method === method).reduce((total, row) => ({
        method, count: total.count + BigInt(row.count), meat: total.meat + BigInt(row.meat), fees: total.fees + BigInt(row.fees),
    }), { method, count: 0n, meat: 0n, fees: 0n }));
    return <section aria-label="Completed auction activity" className="mt-5 border-t border-gray-200 pt-4">
        <h2 className="text-sm font-semibold text-gray-900">Completed auction activity</h2>
        <div className="my-3 grid gap-3 sm:grid-cols-3">
            {[
                ['Transaction volume', meat(transactions.meat)],
                ['Completed transactions', format(transactions.count)],
                ['Average transaction', meat(transactions.average)],
            ].map(([label, value]) => <div key={label} className="min-w-0 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                <h3 className="text-xs font-medium text-gray-600">{label}</h3>
                <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900">{value}</p>
            </div>)}
        </div>
        <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-left text-xs tabular-nums">
                <thead className="bg-gray-50 text-gray-600"><tr>
                    {['Auction type', 'Method', 'Completed', 'Meat traded', 'Escrow fees'].map(label => <th key={label} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{label}</th>)}
                </tr></thead>
                <tbody className="text-gray-700">{rows.map(row => <tr key={`${row.kind}-${row.method}`} className="border-t border-gray-100">
                    <th scope="row" className="px-3 py-2 font-medium capitalize">{row.kind}</th>
                    <td className="px-3 py-2 capitalize">{row.method}</td>
                    <td className="px-3 py-2">{format(row.count)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{meat(row.meat)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.method === 'direct' ? '—' : meat(row.fees)}</td>
                </tr>)}</tbody>
                <tfoot className="border-t border-gray-200 bg-gray-50 font-medium text-gray-700">{methods.map(row => <tr key={row.method}>
                    <th scope="row" colSpan={2} className="px-3 py-2 capitalize">{row.method} total</th>
                    <td className="px-3 py-2">{format(row.count)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{meat(row.meat)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{row.method === 'direct' ? '—' : meat(row.fees)}</td>
                </tr>)}</tfoot>
            </table>
        </div>
        <p className="mt-2 text-xs text-gray-500">All time · Sell and Bundle count completed auctions; Buy counts paid fulfillments, including filled portions of closed orders. Volume excludes fees and unused escrow. Average is rounded down to whole Meat. Fees here cover completed trades; the income cards include all recorded ledger income.</p>
    </section>;
}

TransactionActivity.propTypes = {
    transactions: PropTypes.shape({
        count: PropTypes.string.isRequired,
        meat: PropTypes.string.isRequired,
        average: PropTypes.string.isRequired,
        breakdown: PropTypes.arrayOf(PropTypes.shape({
            kind: PropTypes.string.isRequired,
            method: PropTypes.string.isRequired,
            count: PropTypes.string.isRequired,
            meat: PropTypes.string.isRequired,
            fees: PropTypes.string.isRequired,
        })).isRequired,
    }),
};

export default function AdminAnalytics() {
    const [tab, setTab] = useState('overview');
    const [result, setResult] = useState(null);
    const [error, setError] = useState('');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        let cancelled = false;
        setResult(null); setError('');
        supabase.rpc('read_admin_analytics').then(({ data, error: failure }) => {
            if (cancelled) return;
            if (failure || !data) setError(failure?.code === '42501' ? 'Administrator access required.' : 'Analytics are unavailable. Please retry.');
            else setResult(data);
        }).catch(() => { if (!cancelled) setError('Analytics are unavailable. Please retry.'); });
        return () => { cancelled = true; };
    }, [attempt]);
    return <section aria-label="Administrator analytics" className="rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <nav aria-label="Analytics sections" className="admin-analytics-tabs inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5">
                {['overview', 'giveaways'].map(value => <button key={value} aria-current={tab === value ? 'page' : undefined}
                    onClick={() => setTab(value)}
                    className={`min-h-8 rounded-md border px-3 py-1 text-xs font-medium ${tab === value ? 'border-gray-200 bg-white text-gray-900' : 'border-transparent bg-transparent text-gray-500 hover:text-gray-900'}`}>
                    {value === 'overview' ? 'Overview' : 'Giveaways'}
                </button>)}
            </nav>
            <button onClick={() => setAttempt(value => value + 1)} className="min-h-11 text-sm text-blue-700 hover:underline">Refresh analytics</button>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !result ? <p role="status" className="text-sm text-gray-500">Loading analytics…</p> : <>
            {tab === 'giveaways' ? <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-sm font-medium text-gray-700">Meat stack mania:</h2>
                    <p className="text-2xl font-semibold tabular-nums tracking-tight text-gray-900">{result.giveaways ? `${format(result.giveaways.meat_stack_mania)} Meat` : 'Unavailable'}</p>
                </div>
                <p className="mt-2 text-xs text-gray-500">All completed dense-meat-stack-only auctions hosted by teres minor · 1,000 Meat per stack.</p>
            </div> : <>
            <p className="mb-3 text-xs text-gray-500">Last month is the rolling month ending now. Meat totals count escrow fees and donations recorded in the income ledger.</p>
            <div className="grid gap-3 sm:grid-cols-3">
                {[
                    ['Registered users', result.users.total, result.users.month, 'new last month'],
                    ['Escrow sales · fees', result.sales.total, result.sales.month, 'meat last month'],
                    ['Donations · meat', result.donations.total, result.donations.month, 'meat last month'],
                ].map(([label, total, month, caption]) => <div key={label} className="min-w-0 rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                    <h3 className="text-xs font-medium text-gray-600">{label}</h3>
                    <p className="mt-2 break-words text-2xl font-semibold tabular-nums tracking-tight text-gray-900">{format(total)}</p>
                    <p className="mt-1 text-xs text-gray-500">All time</p>
                    <p className="mt-3 border-t border-gray-200 pt-2 text-xs text-gray-600"><span className="font-semibold tabular-nums text-blue-700">{format(month)}</span> {caption}</p>
                </div>)}
            </div>
            <TransactionActivity transactions={result.transactions} />
            </>}
            <p className="mt-3 text-xs text-gray-400">Updated {new Date(result.generated_at).toLocaleString()}</p>
        </>}
    </section>;
}
