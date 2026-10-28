import PropTypes from 'prop-types';
import { useId } from 'react';
import { meatStackPieceCount } from '../lib/meatStack';

// Clip only the top slice from KoL's original 30×30 icon. Each layer keeps
// the same size; adding layers increases the stack's height.
export default function MeatStack({ total, src = '/art/meatstack.gif' }) {
    const clipId = `meat-slice-${useId().replace(/:/g, '')}`;
    const pieces = meatStackPieceCount(total);
    if (!src || pieces === 0) return null;
    const sliceOffset = 3;
    const stackHeight = 18 + sliceOffset * (pieces - 1);
    return <svg className="profile-meat-stack" aria-hidden="true" focusable="false"
        viewBox={`4 0 24 ${stackHeight}`} width="44" height={stackHeight * 44 / 24}>
        <defs><clipPath id={clipId}><polygon points="6,16 6,9 7,7 9,6 12,5 16,5 18,4 20,4 22,2 24,1 26,1 27,2 27,7 25,10 23,12 20,14 17,17 14,18 10,18 7,17" /></clipPath></defs>
        {Array.from({ length: pieces }, (_, index) => <g key={index} transform={`translate(0 ${(pieces - index - 1) * sliceOffset})`}>
            <image href={src} width="30" height="30" clipPath={`url(#${clipId})`} />
        </g>)}
    </svg>;
}

MeatStack.propTypes = {
    total: PropTypes.any.isRequired,
    src: PropTypes.string,
};
