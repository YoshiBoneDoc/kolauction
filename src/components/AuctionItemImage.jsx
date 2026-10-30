import { useState } from 'react';
import PropTypes from 'prop-types';

const captions = [
    'Presented in stunning 1080p.',
    'Rendered in breathtaking 4K.',
    'Ultra HD. Some imagination required.',
    'Image enhanced by absolutely nothing.',
    'Best viewed from a distance.',
    'Every pixel painstakingly handcrafted.',
    'Optimized for 8K displays.',
    'Photorealism at its peak.',
    'Graphics by the same guys who made Tetris.',
    'Captured in stunning IMAX.',
    'Please allow time for textures to load.',
    'Your GPU is doing its best.',
    'Award-winning visual fidelity.',
    'Best experienced on a 4K OLED.',
    'Visually indistinguishable from reality.',
    'Best viewed with your eyes closed.',
    'Individual pixels sold separately.',
    'Some textures may still be loading.',
];

export default function AuctionItemImage({ src, item, compact = false, size = 'default', className = '', fallbackText = null, enhanceEnabled = false }) {
    const [caption] = useState(() => captions[Math.floor(Math.random() * captions.length)]);
    const [loading, setLoading] = useState(true);
    const [enhancements, setEnhancements] = useState(0);
    const [imageFailed, setImageFailed] = useState(false);
    const damage = Math.min(enhancements, 7);
    const imageSize = size === 'tiny' ? 'h-6 w-6' : compact ? 'h-12 w-12 sm:h-16 sm:w-16' : 'h-28 w-28 sm:h-40 sm:w-40';
    return <figure className={`min-w-0 text-center ${compact || size === 'tiny' ? 'shrink-0' : ''} ${className}`}>
        {!(fallbackText && imageFailed) && <img src={src} alt={item} onLoad={() => setLoading(false)} onError={() => { setLoading(false); if (fallbackText) setImageFailed(true); }}
            style={enhanceEnabled && enhancements ? { filter: `blur(${0.4 + damage * 2}px)`, imageRendering: 'pixelated' } : undefined}
            className={`mx-auto object-contain [image-rendering:pixelated] ${imageSize}`} />}
        {fallbackText && imageFailed && <span role="img" aria-label={`${item} image unavailable`} className="text-center text-[8px] leading-[9px] text-gray-500">{fallbackText}</span>}
        {((!compact && size !== 'tiny') || enhanceEnabled) && <figcaption className="mt-2">
            {!compact && size !== 'tiny' && <span className="block min-h-4 text-[11px] italic text-[#A7B1C0]">{loading ? 'Loading image…' : caption}</span>}
            {enhanceEnabled && <div className="auction-image-enhance-controls">
                <button type="button" disabled={loading || imageFailed} onClick={() => setEnhancements(value => value + 1)} className="auction-image-enhance-button">
                    <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="M20 2v4m-2-2h4" /></svg>
                    enhance image
                </button>
                {enhancements > 0 && <button type="button" onClick={() => setEnhancements(0)} aria-label="Restore original item image"
                    className="text-[11px] text-gray-500 underline hover:text-blue-700">undo</button>}
                <span role="status" className="sr-only">{enhancements ? `Image enhanced ${enhancements} ${enhancements === 1 ? 'time' : 'times'}. Somehow, the quality got worse.` : ''}</span>
            </div>}
        </figcaption>}
    </figure>;
}
AuctionItemImage.propTypes = {
    src: PropTypes.string.isRequired,
    item: PropTypes.string.isRequired,
    compact: PropTypes.bool,
    size: PropTypes.oneOf(['default', 'tiny']),
    className: PropTypes.string,
    fallbackText: PropTypes.string,
    enhanceEnabled: PropTypes.bool,
};
