import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

export default function OfficialApproval() {
    const [image, setImage] = useState(null);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let active = true;
        setFailed(false);

        async function loadApproval() {
            try {
                if (!supabase) throw new Error('Image service unavailable.');
                const { data, error } = await supabase.rpc('read_official_approval_image');
                if (error || data?.mime_type !== 'image/png' || typeof data.base64 !== 'string'
                    || data.base64.length > 2796204 || !/^iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) {
                    throw new Error('Image unavailable.');
                }
                if (active) setImage(`data:image/png;base64,${data.base64}`);
            } catch {
                if (active) setFailed(true);
            }
        }

        loadApproval();
        return () => { active = false; };
    }, [attempt]);

    return (
        <main className="approval-gallery" aria-label="KoL management approval KMail">
            <figure className="approval-frame">
                <img
                    src="/art/approval-abstract-frame.png"
                    alt=""
                    aria-hidden="true"
                    width="500"
                    height="400"
                    className="approval-frame-art"
                />
                <div className="approval-frame-mat">
                    {image ? (
                        <img
                            src={image}
                            alt="Original KMail from CustomerService confirming that kHub is permitted by KoL management."
                            className="approval-kmail-image"
                        />
                    ) : failed ? (
                        <div role="alert" className="p-6 text-center text-gray-900">
                            <p>The approval KMail image could not be loaded.</p>
                            <button type="button" onClick={() => setAttempt(value => value + 1)} className="mt-2 text-blue-700 underline">
                                Try again
                            </button>
                        </div>
                    ) : (
                        <p role="status" className="p-6 text-center text-gray-900">Loading approval KMail…</p>
                    )}
                </div>
            </figure>
        </main>
    );
}
