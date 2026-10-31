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
            {activity ? <div className="space-y-2">
                {[['viewers', 'Viewing now'], ['logged_in', 'Logged in']].map(([key, label]) => <details key={key}>
                    <summary className="cursor-pointer rounded focus-visible:outline focus-visible:outline-2">
                        {label}<span className="block text-lg font-bold">{activity[key]}</span>
                    </summary>
                    {Array.isArray(activity.users) ? <ul aria-label={`${label} users`} className="mt-1 max-h-60 space-y-1 overflow-y-auto break-words text-xs">
                        {activity.users.map(user => <li key={user.id}>{user.username}</li>)}
                        {key === 'viewers' && activity.guests > 0 && <li>Anonymous guests: {activity.guests}</li>}
                        {activity[key] === 0 && <li>No active users</li>}
                    </ul> : <p className="mt-1 text-xs">User list unavailable until the database update is applied.</p>}
                </details>)}
            </div> : <p role="status">Activity unavailable</p>}
            <p className="mt-2 text-xs opacity-70">Active in the last 2 minutes. Includes you. Updates every 30 seconds.</p>
        </aside>}
        <div className="min-w-0 flex-1">{children}</div>
    </div>;
}

SiteActivity.propTypes = { children: PropTypes.node.isRequired };
