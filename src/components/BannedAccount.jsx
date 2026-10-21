import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PropTypes from 'prop-types';
import { countdown } from '../lib/accountRestrictions';

export default function BannedAccount({ account, onLogout }) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const serverTime = now + (account.serverOffset || 0);
    return <main className="flex min-h-screen items-center justify-center bg-gray-50 p-6">
        <section className="w-full max-w-lg space-y-5 rounded-lg border border-red-200 bg-white p-7">
            <h1 className="text-2xl font-bold text-red-800">Your account is banned</h1>
            <p className="text-gray-700">Your access to kHub is restricted. You can submit an appeal for administrator review.</p>
            {account.banExpiresAt ? <div className="rounded border border-gray-200 bg-gray-50 p-4">
                <p className="text-sm text-gray-600">Ban ends {new Date(account.banExpiresAt).toLocaleString()}</p>
                <p role="timer" className="mt-2 text-xl font-semibold tabular-nums text-gray-900">{countdown(account.banExpiresAt, serverTime)}</p>
                <p className="mt-2 text-xs text-gray-500">Access is checked automatically.</p>
            </div> : <p className="font-semibold text-gray-700">This ban has no expiry.</p>}
            <div className="flex flex-wrap items-center gap-5">
                <Link to="/submit-appeal" className="rounded-md bg-blue-700 px-4 py-2 font-medium text-white hover:bg-blue-800 hover:text-white">Submit an appeal</Link>
                <button onClick={onLogout} className="border-0 bg-transparent p-0 text-sm text-gray-600 underline">Sign out</button>
            </div>
        </section>
    </main>;
}
BannedAccount.propTypes = { account: PropTypes.object.isRequired, onLogout: PropTypes.func.isRequired };
