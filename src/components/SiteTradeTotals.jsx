import PropTypes from 'prop-types';
import { formatSiteMeat, parseSiteTradeTotals } from '../lib/siteTradeTotals';

export default function SiteTradeTotals({ totals }) {
    const values = parseSiteTradeTotals(totals);
    if (!values) return null;
    return <div className="mx-auto mt-4 w-full max-w-6xl text-center" aria-label="kHub Milestones">
        <div className="flex items-center gap-3 sm:gap-4">
            <span aria-hidden="true" className="h-px flex-1 bg-gray-300 dark:bg-slate-600" />
            <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-medium text-slate-700 dark:text-slate-200">
                <span className="inline-flex items-center gap-1 whitespace-nowrap" title={`${BigInt(values.meat).toLocaleString('en-US')} Meat`}>
                    <span aria-hidden="true" className="relative inline-block h-[22px] w-[18px] shrink-0 overflow-hidden mix-blend-multiply dark:mix-blend-screen">
                        <img src="/images/site-stats/meat.gif" alt="" className="absolute -left-[3px] -top-px h-6 w-6 max-w-none dark:invert" />
                    </span>{formatSiteMeat(values.meat)} Meat
                </span>
                <span aria-hidden="true" className="text-slate-400">·</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span aria-hidden="true" className="relative inline-block h-[21px] w-[14px] shrink-0 overflow-hidden mix-blend-multiply dark:mix-blend-screen">
                        <img src="/images/site-stats/items.gif" alt="" className="absolute -left-[5px] -top-px h-6 w-6 max-w-none dark:invert" />
                    </span>{BigInt(values.items).toLocaleString('en-US')} Items
                </span>
                <span aria-hidden="true" className="text-slate-400">·</span>
                <span className="inline-flex items-center gap-1 whitespace-nowrap">
                    <span aria-hidden="true" className="relative inline-block h-[21px] w-[27px] shrink-0 overflow-hidden mix-blend-multiply dark:mix-blend-screen">
                        <img src="/images/site-stats/trades.gif" alt="" className="absolute -left-[4px] -top-[10px] h-8 w-8 max-w-none dark:invert" />
                    </span>{BigInt(values.trades).toLocaleString('en-US')} trades
                </span>
            </div>
            <span aria-hidden="true" className="h-px flex-1 bg-gray-300 dark:bg-slate-600" />
        </div>
        <p className="mt-0.5 text-[11px] font-normal text-slate-500 dark:text-slate-400">kHub Milestones</p>
    </div>;
}
SiteTradeTotals.propTypes = { totals: PropTypes.object };
