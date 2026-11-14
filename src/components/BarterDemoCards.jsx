import { Link } from 'react-router-dom';
import { demoListings } from '../lib/barterDemo';

export default function BarterDemoCards() {
    return <section aria-labelledby="barter-practice-title" className="mt-4 rounded-lg border border-dashed border-amber-300 bg-amber-50 p-2.5">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="barter-practice-title" className="text-xs font-semibold">Try bartering — practice auctions</h2>
            <p className="text-[11px] text-gray-500">No real trades</p>
        </div>
        <div className="grid grid-cols-2 gap-2">{['host', 'bidder'].map(role => <Link key={role} to={`/barter/demo/${role}`} className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1.5 hover:border-blue-400">
            <img src={demoListings[role].image} alt="" loading="lazy" className="h-8 w-8 shrink-0 rounded bg-white p-0.5 [image-rendering:pixelated]" />
            <div className="min-w-0"><h3 className="text-xs font-semibold text-blue-700">Play as {role} <span aria-hidden="true">→</span></h3><p className="text-[10px] font-bold text-amber-700">DEMO / FAKE</p></div>
        </Link>)}</div>
    </section>;
}
