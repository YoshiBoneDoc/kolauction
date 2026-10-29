import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { supabase } from '../lib/supabase';
import { createSiteBannerService, readBannerDismissal, dismissBanner } from '../lib/siteBanner';
import { startAuctionRefresh } from '../lib/auctionRefresh';
import { readPublicBanner } from '../lib/publicBannerReader';

const announcements = createSiteBannerService(supabase, {
    publicRead: import.meta.env.VITE_SHARED_AUCTION_CACHE === 'true' ? readPublicBanner : null,
});

export default function SiteBanner({ service = announcements }) {
    const [banner, setBanner] = useState(null);
    const [dismissed, setDismissed] = useState(null);
    useEffect(() => {
        let stopped = false;
        try { setDismissed(readBannerDismissal(window.localStorage)); } catch { /* Storage can be disabled. */ }
        let failures = 0;
        const stop = startAuctionRefresh({ document, window, delay: () => Math.min(300000, 60000 * 2 ** Math.min(failures, 3)), jitter: 0.2, refresh: async () => {
            try {
                const next = await service.read();
                if (!stopped) setBanner(next);
                failures = 0;
            } catch { failures++; /* An unavailable announcement must not block the marketplace. */ }
        } });
        function syncDismissal(event) {
            if (event.key === 'khub.dismissed-site-banner' || event.key === null) {
                try { setDismissed(readBannerDismissal(window.localStorage)); } catch { /* Keep in-memory state. */ }
            }
        }
        window.addEventListener('storage', syncDismissal);
        return () => { stopped = true; stop(); window.removeEventListener('storage', syncDismissal); };
    }, [service]);
    if (!banner?.message || !banner.revision || dismissed === banner.revision) return null;
    function dismiss() {
        setDismissed(banner.revision);
        try { dismissBanner(window.localStorage, banner.revision); } catch { /* Keep in-memory dismissal. */ }
    }
    return <aside aria-label="Site announcement" className="mx-4 mb-3 flex items-start gap-3 rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 sm:mx-6">
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{banner.message}</p>
        <button type="button" onClick={dismiss} aria-label="Dismiss announcement" className="flex h-6 w-6 shrink-0 items-center justify-center border-0 bg-transparent p-0 text-xl leading-none text-amber-800 hover:text-amber-950">×</button>
    </aside>;
}
SiteBanner.propTypes = { service: PropTypes.object };
