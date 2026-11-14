import PropTypes from 'prop-types';

export default function AuctionPagination({ page, totalPages, hasNext, onPage, label = 'Auction pages', className = '' }) {
    return <nav aria-label={label} className={`mt-6 flex items-center justify-center gap-4 ${className}`}>
        <button disabled={page <= 1} onClick={() => onPage(page - 1)} className="min-h-11 rounded border bg-white px-4 py-2 disabled:opacity-50">Previous</button>
        <span>Page {page}{totalPages != null && <> of {totalPages}</>}</span>
        <button disabled={!hasNext} onClick={() => onPage(page + 1)} className="min-h-11 rounded border bg-white px-4 py-2 disabled:opacity-50">Next</button>
    </nav>;
}
AuctionPagination.propTypes = { page: PropTypes.number.isRequired, totalPages: PropTypes.number, hasNext: PropTypes.bool.isRequired, onPage: PropTypes.func.isRequired, label: PropTypes.string, className: PropTypes.string };
