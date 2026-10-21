export function tradeResponseStatus({ confirmedAt, resolvedAt, reportedIncomplete = false, reportExcluded = false }) {
    if (confirmedAt || resolvedAt) return { label: 'Confirmed Complete', color: 'text-green-800', background: 'border-green-200 bg-green-50' };
    if (reportedIncomplete) return { label: 'Reported Incomplete', color: 'text-red-700', background: 'border-red-200 bg-red-50' };
    if (reportExcluded) return { label: 'Report excluded', color: 'text-slate-500', background: 'border-slate-200 bg-slate-50' };
    return { label: 'Awaiting response', color: 'text-slate-500', background: 'border-slate-200 bg-slate-50' };
}

export function tradeResponseSummary({ confirmedComplete, reportedIncomplete, resolvedIncomplete, otherConfirmedComplete, otherReportedIncomplete, reportExcluded, otherReportExcluded }) {
    if (reportExcluded) return 'Your incomplete report was excluded after administrator review.';
    if (reportedIncomplete) {
        if (otherReportedIncomplete) return 'Both you and the other party reported this trade as incomplete.';
        if (otherConfirmedComplete) return 'You reported this trade as incomplete, but the other party confirmed it as complete.';
        if (otherReportExcluded) return 'You reported this trade as incomplete. The other party’s incomplete report was excluded after administrator review.';
        return 'You reported this trade as incomplete. Awaiting the other party’s response.';
    }
    if (!confirmedComplete) return '';
    const summary = otherReportedIncomplete
        ? 'You confirmed this trade as complete, but the other party reported it as incomplete.'
        : otherReportExcluded
            ? 'You confirmed this trade as complete. The other party’s incomplete report was excluded after administrator review.'
        : otherConfirmedComplete
            ? 'Both you and the other party confirmed this trade as complete.'
            : 'You confirmed this trade as complete. Awaiting the other party’s response.';
    return resolvedIncomplete ? `${summary} Your incomplete report was withdrawn.` : summary;
}
