import PropTypes from 'prop-types';

export default function ItemResources({ item, itemId }) {
    const wikiPage = encodeURIComponent(item.trim().replace(/\s+/g, '_'));
    const linkClass = 'rounded border border-[#E8D9D2] bg-white/70 px-1.5 py-0.5 text-xs text-blue-700 transition-colors hover:border-blue-200 hover:bg-white hover:text-blue-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-500';
    return <p className="flex items-center gap-1.5 text-left">
        <a href={`https://wiki.kingdomofloathing.com/${wikiPage}`} target="_blank" rel="noreferrer" className={linkClass}>wiki</a>
        <span aria-hidden="true" className="text-xs text-gray-400">·</span>
        {itemId != null ? <a href={`https://pricegun.loathers.net/item/${encodeURIComponent(itemId)}`} target="_blank" rel="noreferrer" className={linkClass}>pricegun</a> : <span className="text-xs text-gray-600">pricegun</span>}
    </p>;
}

ItemResources.propTypes = { item: PropTypes.string.isRequired, itemId: PropTypes.oneOfType([PropTypes.number, PropTypes.string]) };
