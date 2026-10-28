import PropTypes from 'prop-types';

export default function BundleContents({ items, variant = 'default' }) {
    const isPreview = variant === 'preview';
    return <section aria-label="Bundle contents" className={`${isPreview ? 'bundle-contents-preview my-4 rounded-xl border border-[#EADBD3] bg-[#FFFAF7] p-3 sm:p-4' : 'my-3'} min-w-0`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className={`text-sm font-semibold ${isPreview ? 'text-gray-900' : 'text-gray-800'}`}>Bundle contents</h3>
            <span className={`text-xs tabular-nums ${isPreview ? 'text-gray-700' : 'text-gray-600'}`}>{items.length} item types</span>
        </div>
        <p className={`mt-1 text-xs ${isPreview ? 'text-gray-700' : 'text-gray-600'}`}>One bid buys the entire bundle; items cannot be purchased separately.</p>
        <ul className={`mt-3 ${isPreview ? 'grid grid-cols-1 gap-2 sm:grid-cols-2' : 'divide-y divide-gray-200'}`}>
            {items.map(item => <li key={item.id} className={`${isPreview ? 'bundle-preview-item min-h-12 rounded-lg border border-[#EEE1DA] bg-white/70 px-2.5 py-2 text-gray-900' : 'py-2 text-gray-800'} flex min-w-0 items-center gap-2 text-sm`}>
                {item.image && <img src={item.image} alt="" className={`${isPreview ? 'h-7 w-7' : 'h-8 w-8'} shrink-0 object-contain [image-rendering:pixelated]`} />}
                <span className="min-w-0 break-words leading-snug">{item.name} <span className={`whitespace-nowrap ${isPreview ? 'text-gray-700' : 'text-gray-600'}`}>× {Number(item.quantity).toLocaleString('en-US')}</span></span>
            </li>)}
        </ul>
    </section>;
}
BundleContents.propTypes = { items: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.number.isRequired, quantity: PropTypes.number.isRequired, name: PropTypes.string.isRequired, image: PropTypes.string })).isRequired, variant: PropTypes.oneOf(['default', 'preview']) };
