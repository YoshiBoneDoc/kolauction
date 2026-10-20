import { useContext, useEffect, useState } from 'react';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { createBugReportService } from '../lib/bugReports';

const reports = createBugReportService(supabase);

export default function useAdministrator() {
    const { currentUser } = useContext(UserContext);
    const userId = currentUser?.id;
    const [result, setResult] = useState(null);
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        reports.isAdministrator().then(value => {
            if (!cancelled) setResult({ userId, value });
        }).catch(() => {
            if (!cancelled) setResult({ userId, value: false });
        });
        return () => { cancelled = true; };
    }, [userId]);
    return Boolean(userId && result?.userId === userId && result.value);
}
