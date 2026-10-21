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

export default function AuctionItemImage({ src, item }) {
    const [caption] = useState(() => captions[Math.floor(Math.random() * captions.length)]);
    return <figure className="min-w-0 text-center">
        <img src={src} alt={item} className="mx-auto h-28 w-28 object-contain [image-rendering:pixelated] sm:h-40 sm:w-40" />
        <figcaption className="mt-2 text-xs italic text-[#94A3B8]">{caption}</figcaption>
    </figure>;
}
AuctionItemImage.propTypes = { src: PropTypes.string.isRequired, item: PropTypes.string.isRequired };
