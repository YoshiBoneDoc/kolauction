import { useState } from 'react';
import PropTypes from 'prop-types';

const IMAGE_ENHANCEMENT_ENABLED = false;

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

export default function AuctionItemImage({ src, item, compact = false }) {
    const [caption] = useState(() => captions[Math.floor(Math.random() * captions.length)]);
    const [loading, setLoading] = useState(true);
    const [enhancements, setEnhancements] = useState(0);
    const damage = Math.min(enhancements, 8);
    return <figure className={`min-w-0 text-center ${compact ? 'shrink-0' : ''}`}>
        <img src={src} alt={item} onLoad={() => setLoading(false)} onError={() => setLoading(false)}
            style={IMAGE_ENHANCEMENT_ENABLED && enhancements ? { filter: `blur(${damage * 0.6}px) contrast(${1 + damage * 0.4})`, imageRendering: 'pixelated' } : undefined}
            className={`mx-auto object-contain [image-rendering:pixelated] ${compact ? 'h-12 w-12 sm:h-16 sm:w-16' : 'h-28 w-28 sm:h-40 sm:w-40'}`} />
        {IMAGE_ENHANCEMENT_ENABLED && <><button type="button" disabled={loading} onClick={() => setEnhancements(value => value + 1)}
            className="mt-1 border-0 bg-transparent p-0 text-[10px] leading-4 text-blue-700 underline hover:text-blue-800 disabled:cursor-wait disabled:opacity-50">enhance image</button>
        {enhancements > 0 && <button type="button" onClick={() => setEnhancements(0)} aria-label="Restore original item image"
            className="ml-2 border-0 bg-transparent p-0 text-[10px] leading-4 text-gray-500 underline">undo</button>}
        <span role="status" className="sr-only">{enhancements ? `Image enhanced ${enhancements} ${enhancements === 1 ? 'time' : 'times'}. Somehow, the quality got worse.` : ''}</span></>}
        {!compact && <figcaption className="mt-2 min-h-4 text-[11px] italic text-[#A7B1C0]">{loading ? 'Loading image…' : caption}</figcaption>}
    </figure>;
}
AuctionItemImage.propTypes = { src: PropTypes.string.isRequired, item: PropTypes.string.isRequired, compact: PropTypes.bool };
