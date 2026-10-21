import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { RestrictionEditor } from './AdminAccountControls';
import { createAccountRestrictionService } from '../lib/accountRestrictions';
import { supabase } from '../lib/supabase';

const accounts = createAccountRestrictionService(supabase);

export default function AppealBanControls({ reportId, children, expanded, onToggle, controlsId, onBanUpdated }) {
    const [attempt, setAttempt] = useState(0);
    const [snapshot, setSnapshot] = useState(null);
    useEffect(() => {
        let cancelled = false;
        accounts.reportAccount(reportId).then(account => {
            if (!cancelled) setSnapshot({ reportId, attempt, account, error: '' });
        }).catch(failure => {
            if (!cancelled) setSnapshot({ reportId, attempt, account: null, error: failure.message });
        });
        return () => { cancelled = true; };
    }, [reportId, attempt]);
    const current = snapshot?.reportId === reportId && snapshot.attempt === attempt ? snapshot : null;
    const summary = status => <button type="button" aria-expanded={expanded} aria-controls={controlsId} onClick={onToggle}
        className="appeal-summary-toggle flex min-w-0 flex-1 basis-full items-center gap-3 rounded-none border-0 bg-transparent p-0 text-left hover:bg-transparent min-[480px]:basis-0">
        <span className="grid min-w-0 flex-1 items-start gap-x-4 gap-y-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <span className="min-w-0">{children}</span>
            <span className="min-w-0">{status}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-gray-400">{expanded ? '▴' : '▾'}</span>
    </button>;

    return <div aria-label="Appeal account controls" className="min-w-0 flex-1 basis-full sm:basis-0">
        {current?.account ? <RestrictionEditor key={current.account.id} account={current.account}
            onUpdated={() => { setAttempt(value => value + 1); onBanUpdated(); }} renderSummary={summary} />
            : <div className="appeal-ban-card space-y-2 rounded bg-gray-50 px-3 py-2">
                {summary(<span className="mt-1 block text-xs text-gray-500">{!current ? 'Loading ban details…' : current.error ? 'Ban details unavailable.' : 'Account no longer available.'}</span>)}
                {current?.error && <div className="flex flex-wrap items-center gap-3 text-xs">
                    <p role="alert" className="text-red-700">{current.error}</p>
                    <button type="button" onClick={() => setAttempt(value => value + 1)} className="text-blue-700 underline">Retry ban details</button>
                </div>}
            </div>}
    </div>;
}

AppealBanControls.propTypes = {
    reportId: PropTypes.string.isRequired, children: PropTypes.node.isRequired,
    expanded: PropTypes.bool.isRequired, onToggle: PropTypes.func.isRequired, controlsId: PropTypes.string.isRequired,
    onBanUpdated: PropTypes.func.isRequired,
};
