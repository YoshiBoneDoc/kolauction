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
    const ownPresence = activity?.users?.some(user => user.id === signedInUserId) ? 1 : 0;
    const otherUsers = activity?.users?.filter(user => user.id !== signedInUserId);

    useEffect(() => {
        if (!supabase) return;
        let cancelled = false;
        let pending = false;
        const id = visitorId();
        async function refresh() {
            if (document.visibilityState !== 'visible' || pending) return;
            pending = true;
            try {
                const heartbeat = async () => {
                    const key = 'khub-activity-last-heartbeat';
                    let last = 0;
                    const identity = signedInUserId || 'guest';
                    try { if (localStorage.getItem(key + '-identity') === identity) last = Number(localStorage.getItem(key)) || 0; } catch { /* Storage unavailable. */ }
                    if (Date.now() - last < 60000) return;
                    const result = await supabase.rpc('khub_record_site_activity', { p_visitor_id: id });
                    if (result.error) throw result.error;
                    try { localStorage.setItem(key, String(Date.now())); localStorage.setItem(key + '-identity', identity); } catch { /* Storage unavailable. */ }
                };
                // Web Locks serialize the timestamp check across tabs, including slow RPCs.
                if (navigator.locks) await navigator.locks.request('khub-site-activity', heartbeat);
                else await heartbeat();
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
        const timer = setInterval(refresh, 60_000);
        document.addEventListener('visibilitychange', refresh);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', refresh);
        };
    }, [administrator, signedInUserId]);

    return <div className="relative flex flex-1 flex-col">
        {administrator && <aside aria-label="Site activity" className="m-4 rounded border border-gray-300 p-3 text-sm lg:absolute lg:left-0 lg:top-0 lg:z-10 lg:w-36">
            <h2 className="mb-2 font-bold">Site activity</h2>
            {activity ? <div className="space-y-2">
                <p>Viewing now<span className="block text-lg font-bold">{Math.max(0, activity.viewers - ownPresence)}</span></p>
                {Array.isArray(activity.users) ? <ul aria-label="Viewing now users" className="mt-1 max-h-60 space-y-1 overflow-y-auto break-words text-xs">
                    {otherUsers.map(user => <li key={user.id}>{user.username}</li>)}
                    <li>Other users: {activity.guests ?? 0}</li>
                </ul> : <p className="mt-1 text-xs">User list unavailable until the database update is applied.</p>}
            </div> : <p role="status">Activity unavailable</p>}
            <p className="mt-2 text-xs opacity-70">Active last 2 minutes.<br />Updated every 60 sec</p>
        </aside>}
        <div className="min-w-0 flex-1">{children}</div>
    </div>;
}

SiteActivity.propTypes = { children: PropTypes.node.isRequired };
