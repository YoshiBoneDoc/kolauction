export function formatBuyAuditDate(value) {
    const date=new Date(value);
    if(!Number.isFinite(date.getTime()))return 'Unknown time';
    return date.toLocaleString('en-US',{month:'2-digit',day:'2-digit',year:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true})
        .replace(',','').replace(/\s*(AM|PM)$/i,match=>match.trim().toLowerCase());
}

export function describeBuyAuditEvent(event) {
    const details=event.details || {},actor=event.actor_name || 'User';
    const quantity=Number(details.quantity),meat=Number(details.meat);
    const items=Number.isSafeInteger(quantity)&&quantity>0?`${quantity.toLocaleString('en-US')} ${quantity===1?'item':'items'}`:'items';
    const amount=Number.isSafeInteger(meat)&&meat>=0?`${meat.toLocaleString('en-US')} Meat`:'Funds';
    switch(event.kind) {
        case 'reservation_created': return `${actor} reserved ${items}`;
        case 'reservation_cancelled': return `${actor} cancelled a reservation for ${items}`;
        case 'gift_charged': return `${amount} charged for gift packaging`;
        case 'gift_released': return `${amount} gift-packaging reserve released`;
        case 'bot_packaging_paid': return `kHub paid ${amount} for gift packaging`;
        case 'bot_packaging_authorized': return 'Gift packaging approved';
        case 'delivery_not_attempted': return 'Delivery deferred; nothing sent';
        case 'packaging_sponsored': return 'kHub took over gift packaging costs';
        case 'quantity_adjusted': return 'Available order quantity adjusted';
        case 'quantity_restored': return `${items} restored to the order`;
        case 'items_batched': return `${items} grouped for delivery`;
        case 'topup': return `Order funding increased by ${amount}`;
        default: return String(event.kind || 'Order updated').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
    }
}
