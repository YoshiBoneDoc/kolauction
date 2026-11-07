import PropTypes from 'prop-types';

export default function PaymentAssets({ meat, mrA = 0 }) {
    return <span className="inline-flex flex-wrap items-center justify-end gap-1">
        {mrA > 0 && <>{mrA.toLocaleString('en-US')} x <img src="/art/mr-accessory.svg" alt="Mr. A" className="h-6 w-auto shrink-0" /></>}
        {(meat > 0 || !mrA) && <span>{mrA > 0 ? '+ ' : ''}{meat.toLocaleString('en-US')} Meat</span>}
    </span>;
}

PaymentAssets.propTypes = { meat: PropTypes.number.isRequired, mrA: PropTypes.number };
