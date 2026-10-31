import { useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { UserContext } from '../context/UserContext';
import useAdministrator from '../hooks/useAdministrator';
import { supabase } from '../lib/supabase';

// Share a random visitor ID across tabs; never store account details here.
let fallbackVisitorId;
function visitorId() {
    try {
        const stored = localStorage.getItem('khub-activity-visitor');
        if (stored && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(stored)) return stored;
        const id = crypto.randomUUID();
        localStorage.setItem('khub-activity-visitor', id);
        return id;
    } catch {
        fallbackVisitorId ||= crypto.randomUUID();
        return fallbackVisitorId;
    }
}

export default function SiteActivity({ children }) {
    const { signedInUserId } = useContext(UserContext);
    const administrator = useAdministrator();
    const [activity, setActivity] = useState(null);

    useEffect(() => {
        if (!supabase) return;
        let cancelled = false;
        let pending = false;
        const id = visitorId();
        async function refresh() {
            if (document.visibilityState !== 'visible' || pending) return;
            pending = true;
            try {
                const heartbeat = await supabase.rpc('khub_record_site_activity', { p_visitor_id: id });
                if (heartbeat.error) throw heartbeat.error;
                if (administrator) {
                    const { data, error } = await supabase.rpc('khub_site_activity_counts');
                    if (error) throw error;
                    if (!cancelled) setActivity(data);
                }
            } catch {
                if (!cancelled) setActivity(null);
            } finally {
                pending = false;
            }
        }
        refresh();
        const timer = setInterval(refresh, 30_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [administrator, signedInUserId]);

    return <div className={administrator ? 'grid flex-1 items-start lg:grid-cols-[10rem_minmax(0,1fr)]' : 'flex flex-1 flex-col'}>
        {administrator && <aside aria-label="Site activity" className="m-4 rounded border border-gray-300 p-3 text-sm lg:sticky lg:top-4 lg:mr-0">
            <h2 className="mb-2 font-bold">Site activity</h2>
            {activity ? <dl className="space-y-2">
                <div><dt>Viewing now</dt><dd className="text-lg font-bold">{activity.viewers}</dd></div>
                <div><dt>Logged in</dt><dd className="text-lg font-bold">{activity.logged_in}</dd></div>
            </dl> : <p role="status">Activity unavailable</p>}
            <p className="mt-2 text-xs opacity-70">Active in the last 2 minutes. Includes you. Updates every 30 seconds.</p>
        </aside>}
        <div className="min-w-0 flex-1">{children}</div>
    </div>;
}

SiteActivity.propTypes = { children: PropTypes.node.isRequired };
