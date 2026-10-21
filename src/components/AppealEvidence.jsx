import { useState } from 'react';
import PropTypes from 'prop-types';
import { createBugReportService } from '../lib/bugReports';
import { evidenceDataUrl } from '../lib/accountRestrictions';
import { supabase } from '../lib/supabase';
const reports = createBugReportService(supabase);
export default function AppealEvidence({ reportId }) {
    const [source, setSource] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function load() {
        if (pending) return;
        setPending(true); setError('');
        try { setSource(evidenceDataUrl(await reports.readAppealEvidence(reportId))); }
        catch (failure) { setError(failure.message); }
        finally { setPending(false); }
    }
    return <div className="space-y-2">
        {source ? <a href={source} download={`appeal-evidence-${reportId}`} className="block w-fit">
            <img src={source} alt="Evidence attached to this appeal" className="max-h-80 max-w-full rounded border border-gray-200 object-contain" />
            <span className="text-xs text-blue-700 underline">Download evidence</span>
        </a> : <button disabled={pending} onClick={load} className="border-0 bg-transparent p-0 text-sm text-blue-700 underline">{pending ? 'Loading evidence…' : 'View evidence image'}</button>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>;
}
AppealEvidence.propTypes = { reportId: PropTypes.string.isRequired };
