import { useEffect, useState } from 'react';
import PropTypes from 'prop-types';

const processed = new Map();
const emptyImage = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
function cutout(source) {
    if (processed.has(source)) return processed.get(source);
    const result = new Promise(resolve => {
        const path = source.replace('https://images.kingdomofloathing.com/', '');
        const picture = new Image();
        const candidates = source.includes('/Special:Redirect/file/Shoppeng.gif')
            ? ['/api/giveaway-image?penguin=1', source]
            : source.startsWith('https://images.kingdomofloathing.com/')
                ? [`/api/giveaway-image?path=${encodeURIComponent(path)}`, `/art/${encodeURIComponent(path.split('/').at(-1))}`, source]
                : [source];
        let attempt = 0;
        function next() {
            if (attempt >= candidates.length) { resolve(emptyImage); return; }
            const candidate = candidates[attempt++];
            picture.crossOrigin = candidate.startsWith('/') || candidate.startsWith('data:') ? null : 'anonymous';
            picture.src = candidate;
        }
        picture.onload = () => {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = picture.naturalWidth; canvas.height = picture.naturalHeight;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(picture, 0, 0);
                const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const { data, width, height } = pixels;
                const seen = new Uint8Array(width * height), queue = [];
                const visit = index => {
                    if (index < 0 || index >= seen.length || seen[index]) return;
                    seen[index] = 1;
                    const p = index * 4;
                    if (data[p + 3] === 0 || data[p] >= 240 && data[p + 1] >= 240 && data[p + 2] >= 240) queue.push(index);
                };
                for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
                for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
                for (let head = 0; head < queue.length; head++) {
                    const index = queue[head]; data[index * 4 + 3] = 0;
                    if (index % width) visit(index - 1);
                    if (index % width < width - 1) visit(index + 1);
                    visit(index - width); visit(index + width);
                }
                let left = width, top = height, right = 0, bottom = 0;
                for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (data[(y * width + x) * 4 + 3]) {
                    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
                }
                if (left > right || top > bottom) return resolve(emptyImage);
                ctx.putImageData(pixels, 0, 0);
                const cropped = document.createElement('canvas'); cropped.width = right - left + 1; cropped.height = bottom - top + 1;
                cropped.getContext('2d').drawImage(canvas, left, top, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
                resolve(cropped.toDataURL());
            } catch { next(); }
        };
        picture.onerror = next;
        next();
    });
    processed.set(source, result);
    return result;
}
export function useGiveawayCutout(source) {
    const [image, setImage] = useState({ source: null, url: emptyImage });
    useEffect(() => {
        if (!source) return;
        let active = true;
        cutout(source).then(url => { if (active) setImage({ source, url }); });
        return () => { active = false; };
    }, [source]);
    return image.source === source ? image.url : emptyImage;
}
export default function GiveawayItemImage({ source, className = '', style }) {
    const image = useGiveawayCutout(source);
    return <img src={image} alt="" style={style} className={`object-contain [image-rendering:pixelated] ${className}`} />;
}
GiveawayItemImage.propTypes = { source: PropTypes.string.isRequired, className: PropTypes.string, style: PropTypes.object };
