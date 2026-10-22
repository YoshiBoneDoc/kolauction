import { useEffect, useLayoutEffect, useRef } from 'react';
import PropTypes from 'prop-types';

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

// Measure this line independently so long prices do not change neighboring cards.
export default function FittedPrice({ as: Tag = 'span', fitKey, className = '', children, title }) {
    const ref = useRef(null);
    useBrowserLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        let active = true;
        function fit() {
            if (!active) return;
            // Always start from the normal CSS size, allowing the line to grow
            // back when its text gets shorter or its card gets wider.
            element.style.fontSize = '';
            const available = element.clientWidth;
            if (!available || element.scrollWidth <= available) return;
            let size = Number.parseFloat(getComputedStyle(element).fontSize);
            for (let attempt = 0; attempt < 3 && element.scrollWidth > available; attempt += 1) {
                size *= (available - 1) / element.scrollWidth;
                element.style.fontSize = `${size}px`;
            }
        }
        fit();
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
        observer?.observe(element);
        window.addEventListener('resize', fit);
        document.fonts?.addEventListener('loadingdone', fit);
        document.fonts?.ready.then(fit);
        return () => {
            active = false;
            observer?.disconnect();
            window.removeEventListener('resize', fit);
            document.fonts?.removeEventListener('loadingdone', fit);
        };
    }, [fitKey]);
    return <Tag ref={ref} title={title} className={`whitespace-nowrap ${className}`}>{children}</Tag>;
}
FittedPrice.propTypes = {
    as: PropTypes.string,
    fitKey: PropTypes.string.isRequired,
    className: PropTypes.string,
    children: PropTypes.node.isRequired,
    title: PropTypes.string,
};
