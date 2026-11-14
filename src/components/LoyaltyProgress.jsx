import { useContext, useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Link } from 'react-router-dom';
import { UserContext } from '../context/UserContext';
import { supabase } from '../lib/supabase';
import { loyaltyTiers as tiers, loyaltySaleBands } from '../lib/loyaltyPreview';
import { compactLoyaltyMeat as compact, loyaltyProgress, readLoyaltySales } from '../lib/loyaltyProgress';

export function LoyaltyProgressPanel({ sales = null, signedIn = false, loading = false, error = '', onRetry, children, leaderboardBenefit = null }) {
    const [preview, setPreview] = useState(null);
    const progress = sales !== null ? loyaltyProgress(sales) : null;
    const earnedIndex = progress?.earnedIndex;
    const selectedIndex = preview ?? earnedIndex ?? 0;
    const tier = tiers[selectedIndex];
    const benefit = preview === null ? leaderboardBenefit : null;
    const rates = benefit?.rates || tier.rates;
    const resetPreview = () => setPreview(null);
    return <section className="club-progression" aria-labelledby="club-rewards-title">
        <aside className="club-rewards-sidebar" aria-labelledby="club-rewards-title">
            <h2 id="club-rewards-title">Tier Benefits</h2>
        {loading && <p role="status" className="club-progress-status">Loading your sales progress…</p>}
        {error && <p role="alert" className="club-progress-status">{error} <button type="button" onClick={onRetry}>Retry</button></p>}
        {!signedIn && !loading && <p className="club-progress-status"><Link to="/login">Log in</Link> to see your completed escrow sales and membership progress.</p>}

        <div className="club-tier-track" role="group" aria-label="Lifetime sales membership tiers">
            {tiers.map((item, index) => <button key={item.name} type="button"
                className={`club-tier-step bg-transparent ${item.color} ${earnedIndex === index ? 'is-current' : ''} ${preview === index ? 'is-previewing' : ''}`}
                aria-pressed={selectedIndex === index} aria-controls="club-tier-benefits"
                aria-label={`${item.name}, ${compact(item.minimum)} Meat required${earnedIndex === index ? ', your current tier' : ''}`}
                onMouseEnter={() => setPreview(index)} onMouseLeave={resetPreview}
                onFocus={() => setPreview(index)} onBlur={resetPreview} onClick={() => setPreview(index)}>
                <span className="club-tier-title">{item.name}</span>
                <span className="club-tier-segment" aria-hidden="true"><span className="club-tier-fill" style={{ width: `${progress?.fills[index] ?? 0}%` }} /></span>
                <span className="club-tier-labels"><span className="club-tier-progress-label">{earnedIndex === index ? 'Current' : '\u00a0'}</span>{index > 0 && (sales === null || sales <= BigInt(item.minimum)) && <span className="club-tier-threshold">{compact(item.minimum)}</span>}</span>
            </button>)}
        </div>

        {progress && <div className="club-sales-summary" role="progressbar" aria-label={progress.next ? `Progress toward ${progress.next.name}` : 'Diamond membership reached'}
            aria-valuemin={progress.next ? tiers[earnedIndex].minimum : 0} aria-valuemax={progress.next?.minimum ?? tiers[earnedIndex].minimum}
            aria-valuenow={Number(progress.next ? sales : BigInt(tiers[earnedIndex].minimum))}
            aria-valuetext={`${sales.toLocaleString('en-US')} Meat in lifetime completed escrow sales. ${progress.next ? `${progress.remaining.toLocaleString('en-US')} Meat to ${progress.next.name}.` : 'Highest tier reached.'}`}>
            <span title={`${sales.toLocaleString('en-US')} Meat in completed escrow sales`}>{compact(sales)}{sales < 1000n ? ' Meat' : ''} Lifetime escrow sales</span>
            <span aria-hidden="true"> · </span>
            <span>{progress.next ? `${compact(progress.remaining)} to ${progress.next.name}` : 'Diamond · Highest tier reached'}</span>
        </div>}
        <div id="club-tier-benefits" className={`club-tier-detail ${benefit?.color || tier.color}`} aria-live="polite" aria-atomic="true">
            <div className="club-benefit-heading">
                <h3>{preview === null && (earnedIndex !== undefined || benefit) && 'Current: '}<span className="club-benefit-tier-name">{benefit?.label || tier.name}</span></h3>

            </div>
            <dl className="club-rate-grid">{loyaltySaleBands.map((band, index) => <div key={band}>
                <dt>{band}</dt><dd>{rates[index]}<span>%</span></dd>
            </div>)}</dl>
        </div>
        <p className="club-rewards-note">Only completed escrow sales count toward your loyalty tier.</p>
        {children}
        </aside>
    </section>;
}
LoyaltyProgressPanel.propTypes = { sales: PropTypes.bigint, signedIn: PropTypes.bool, loading: PropTypes.bool, error: PropTypes.string, onRetry: PropTypes.func, children: PropTypes.node, leaderboardBenefit: PropTypes.object };

export default function LoyaltyProgress({ children, leaderboardBenefit = null }) {
    const { currentUser, authorizationScope } = useContext(UserContext);
    const scope = authorizationScope || currentUser?.id;
    const [snapshot, setSnapshot] = useState(null);
    const [attempt, setAttempt] = useState(0);
    const userId = currentUser?.id;
    useEffect(() => {
        if (!userId) return;
        const controller = new AbortController();
        let cancelled = false;
        readLoyaltySales(supabase, controller.signal).then(sales => {
            if (!cancelled) setSnapshot({ scope, attempt, sales });
        }).catch(() => {
            if (!cancelled) setSnapshot({ scope, attempt, error: 'Your sales progress is unavailable.' });
        });
        return () => { cancelled = true; controller.abort(); };
    }, [userId, scope, attempt]);
    const result = userId && snapshot?.scope === scope && snapshot.attempt === attempt ? snapshot : null;
    return <LoyaltyProgressPanel key={userId || 'guest'} signedIn={Boolean(userId)} sales={result?.sales ?? null} leaderboardBenefit={leaderboardBenefit}
        loading={Boolean(userId && !result)} error={result?.error || ''} onRetry={() => setAttempt(value => value + 1)}>{children}</LoyaltyProgressPanel>;
}

LoyaltyProgress.propTypes = { children: PropTypes.node, leaderboardBenefit: PropTypes.object };
