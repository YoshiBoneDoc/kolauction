import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as router from 'react-router-dom';
import { fileURLToPath } from 'node:url';

const { outputFiles } = buildSync({
    stdin: {
        contents: `
            import React from 'react';
            import { renderToStaticMarkup } from 'react-dom/server';
            import { StaticRouter } from 'react-router-dom';
            import App from './src/App.jsx';
            import { AuctionsContext } from './src/context/AuctionsContext.jsx';
            import { UserContext } from './src/context/UserContext.jsx';
            export function render(path, auctions, user = null) {
                return renderToStaticMarkup(
                    <StaticRouter location={path}>
                        <UserContext.Provider value={{currentUser: user}}>
                            <AuctionsContext.Provider value={{auctions, isLoading: false, error: ''}}><App /></AuctionsContext.Provider>
                        </UserContext.Provider>
                    </StaticRouter>
                );
            }
        `,
        resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx',
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', loader: { '.gif': 'dataurl' },
});
const compiled = { exports: {} };
const requireModule = createRequire(import.meta.url);
new Function('require', 'module', 'exports', outputFiles[0].text)((name) => name === 'react-router-dom' ? router : requireModule(name), compiled, compiled.exports);
const { render } = compiled.exports;

test('Info explains first bids, both trade modes and exact buyouts alongside all nine threshold rows', () => {
    const html = render('/info', []);
    assert.match(html, /Minimum Bid Increases/);
    assert.match(html, /first bid must meet the seller/);
    assert.match(html, /both Escrow and Direct Trade/);
    assert.match(html, /Buyouts can always be accepted at their listed price, even if below the next minimum bid/);
    const table = html.match(/<table[^>]*>\s*<caption[^>]*>Minimum increases[\s\S]*?<\/table>/)[0];
    assert.equal((table.match(/<tr/g) || []).length, 10);
    assert.match(table, /10m–under 100m/);
    assert.match(table, /10b and above/);
    assert.match(table, /1% \(rounded up\)/);
});
const base = { sellerId: 'seller', owner: 'Seller', quantity: 1, minBidMeat: 100, currentBid: 0, bids: [], createdAt: Date.now(), endTime: Date.now() + 3600000, status: 'active' };
const auctions = [
    { ...base, id: 'active', item: 'Active accessory' },
    { ...base, id: 'complete', item: 'Completed accessory', status: 'completed', finalPrice: 200, winnerId: 'buyer', winner: 'Buyer' },
    { ...base, id: 'pending', item: 'Pending accessory', status: 'awaiting_trade' },
    { ...base, id: 'expired', item: 'Expired accessory', endTime: Date.now() - 1000, bids: Array(10).fill({bidder: 'Buyer', amount: 200, timestamp: Date.now() - 10000}) },
];

test('auction details render server-authorized bidder names without replacing them with aliases', () => {
    const listing = { ...auctions[0], owner: 'Actual Seller', currentBid: 200,
        highestBidderId: 'bidder-b', highestBidder: 'Actual Bidder B', usernamesVisible: true,
        bids: [{ id: 'a', bidderId: 'bidder-a', bidder: 'Actual Bidder A', amount: 100, timestamp: Date.now() },
            { id: 'b', bidderId: 'bidder-b', bidder: 'Actual Bidder B', amount: 200, timestamp: Date.now() }] };
    const html = render('/auction/active', [listing], { id: 'administrator' });
    assert.match(html, /Actual Seller/);
    assert.match(html, /Actual Bidder A/);
    assert.match(html, /Actual Bidder B/);
});

test('browse route applies URL search and completed filter together to real auction cards', () => {
    const html = render('/auctions?q=ACCESSORY&status=completed&sort=price-desc', auctions);
    assert.match(html, /Completed accessory/);
    assert.match(html, /1 auction found/);
    for (const name of ['Active accessory', 'Pending accessory', 'Expired accessory']) assert.doesNotMatch(html, new RegExp(name));
    assert.doesNotMatch(html, /Place Bid/);
    assert.match(html, /Final price/);
    assert.match(html, /href="\/auction\/complete"/);
    assert.doesNotMatch(html, /More Info|View outcome and history|Sold by|Auction #/);
});

test('browse cards and detail summaries show the same trade status for every viewer', () => {
    for (const [changes,label,color] of [
        [{status:'awaiting_trade'},'Awaiting settlement','476A91'],
        [{status:'awaiting_trade',tradeReported:true},'Reported Incomplete','DC2626'],
        [{status:'awaiting_trade',sellerReportedIncomplete:true},'Reported Incomplete','DC2626'],
        [{status:'awaiting_trade',buyerReportedIncomplete:true},'Reported Incomplete','DC2626'],
        [{status:'completed',tradeReported:true},'Trade completed','15803D'],
        [{status:'cancelled'},'Cancelled','64748B'],
    ]) {
        const listing={...base,id:'status',item:'Status item',escrowMode:false,currentBid:200,finalPrice:200,
            winnerId:'buyer',winner:'Buyer',hasWinner:true,publicWinner:true,...changes};
        for (const user of [null,{id:'seller'},{id:'buyer'},{id:'other'}]) {
            const card=render('/auctions?status=all',[listing],user);
            const details=render('/auction/status',[listing],user);
            assert.ok(card.includes(`text-xs font-semibold text-[#${color}]">${label}</p>`));
            assert.doesNotMatch(card, /Winner:|Sold by|Auction #/);
            assert.ok(details.includes(`text-lg font-bold text-[#${color}]">${label}</p>`));
            assert.match(card,/>Direct<\/span>/);
            assert.doesNotMatch(card,/>Direct settlement</);
        }
    }
});

test('homepage highlights only open listings even when expired auctions have more bids', () => {
    const html = render('/', auctions);
    assert.match(html, /Active accessory/);
    for (const name of ['Completed accessory', 'Pending accessory', 'Expired accessory']) assert.doesNotMatch(html, new RegExp(name));
    assert.match(render('/', auctions.slice(1)), /No active auctions right now/);
});

test('direct detail routes expose bid fields only to eligible signed-in bidders', () => {
    assert.match(render('/auction/active', auctions), /Log in to bid/);
    const eligible = render('/auction/active', auctions, {id: 'buyer'});
    assert.match(eligible, /Your bid \(Meat\)/);
    assert.match(eligible, /inputMode="decimal"/);
    assert.doesNotMatch(render('/auction/active', auctions, {id: 'seller'}), /Your bid \(Meat\)/);
    assert.doesNotMatch(render('/auction/expired', auctions, {id: 'buyer'}), /Your bid \(Meat\)/);
});

test('instant purchase controls appear for eligible buyers including the highest bidder, but never the seller or expired listings', () => {
    const listing = { ...auctions[0], instantPurchasePrice: 1000, highestBidderId: 'buyer' };
    const buyer = render('/auction/active', [listing], {id: 'buyer'});
    assert.match(buyer, /Buy Now/);
    assert.match(buyer, /You are the highest bidder/);
    const seller = render('/auction/active', [listing], {id: 'seller'});
    assert.doesNotMatch(seller, /<button[^>]*>Buy Now/);
    assert.match(seller, /Your optional buyout offer/);
    const loggedOut = render('/auction/active', [listing]);
    assert.doesNotMatch(loggedOut, /Log in to buy/);
    assert.match(loggedOut, /Log in to bid/);
    assert.match(loggedOut, /1,000 Meat/);
    assert.doesNotMatch(render('/auction/active', [{ ...listing, endTime: 1 }], {id: 'buyer'}), /Buy Now/);
    assert.doesNotMatch(render('/auction/active', auctions, {id: 'buyer'}), /Buyout Price/);
});

test('listing form labels instant purchase optional and homepage shows its amount', () => {
    assert.match(render('/auction-item', auctions, {id: 'seller'}), /Set Buyout Price \(optional\)/);
    assert.match(render('/', [{ ...auctions[0], instantPurchasePrice: 1000 }]), /Buyout Price: 1k/);
});

test('empty item search shows a typing hint without a catalog dropdown', () => {
    const html = render('/auction-item', auctions, {id: 'seller'});
    assert.doesNotMatch(html, /<select id="item"|Showing the first 100 of|No items match your search/);
    assert.match(html, /Start typing an item name…/);
});

test('instant purchase outcome retains pending settlement and hides further purchase controls', () => {
    const listing = { ...auctions[0], status: 'awaiting_trade', instantPurchasePrice: 1000, instantPurchasedAt: '2026-10-19T12:00:00Z', finalPrice: 1000, winnerId: 'buyer', winner: 'Buyer' };
    const html = render('/auction/active', [listing], {id: 'buyer'});
    assert.match(html, /Buyout accepted for 1,000 Meat/);
    assert.match(html, /Awaiting settlement/);
    assert.doesNotMatch(html, /Trade completed/);
    assert.doesNotMatch(html, /Buy Now/);
});

test('escrow auctions show one BID command and the optional instant price beside the current bid', () => {
    const listing = { ...auctions[0], auctionNumber: '1001', escrowMode: true, itemId: 1, currentBid: 200, instantPurchasePrice: 1000 };
    const html = render('/auction/active', [listing], {id:'buyer'});
    assert.match(html, /BID 1001/);
    assert.match(html, /Place a Bid/);
    assert.match(html, /Attach at least 210 Meat, with no items/);
    assert.match(html, /Outbid or rejected bids are automatically refunded/);
    assert.match(html, />Live<\/span>/);
    assert.doesNotMatch(html, /<h2[^>]*>Active<\/h2>/);
    assert.doesNotMatch(html, /BUY 1001/);
    assert.equal((html.match(/BID 1001/g) || []).length, 1);
    assert.match(html, /Use the same BID command. Any excess Meat is returned/);
    assert.ok(html.indexOf('Current Bid') < html.indexOf('Buyout Price'));
    assert.ok(html.indexOf('Buyout Price') < html.indexOf('Sold by:'));
    assert.doesNotMatch(html, /(?:BID|BUY) active/);
    assert.match(html, /Auction #1001/);
    assert.match(html, /kHub \(#3888760\)/);
    assert.doesNotMatch(html, /<button[^>]*>Buy Now/);
    assert.doesNotMatch(html, /Your bid \(Meat\)/);
    const withoutInstant = render('/auction/active', [{ ...listing, instantPurchasePrice: null }], {id: 'buyer'});
    assert.equal((withoutInstant.match(/BID 1001/g) || []).length, 1);
    assert.doesNotMatch(withoutInstant, /Buyout Price/);
});

test('pending item deposits display seller deposit instructions without internal item IDs', () => {
    const listing = { ...auctions[0], auctionNumber:'1001', escrowMode:true, status:'pending_escrow', itemId:1, auctionTime:24, startOnDeposit:true };
    const html = render('/auction/active', [listing], {id:'seller'});
    assert.match(html,/LIST 1001/);
    assert.doesNotMatch(html,/item #\d+/);
    assert.match(html,/24-hour timer starts/);
    assert.doesNotMatch(html,/Your bid \(Meat\)/);
});

test('escrow settlement has no manual confirmation control and profile separates pending deposits', () => {
    const listing = { ...auctions[0], escrowMode:true, status:'settling', itemId:1, winnerId:'buyer', winner:'Buyer', finalPrice:1000 };
    const html=render('/auction/active',[listing],{id:'buyer'});
    assert.match(html,/Sending escrow deliveries/);
    assert.doesNotMatch(html,/Confirm Complete/);
    const profile=render('/profile',[{...listing,status:'pending_escrow'}],{id:'seller'});
    assert.match(profile,/Awaiting item deposit/);
    assert.match(profile,/Get verification code/);
});


test('auction lists abbreviate prices while individual details keep exact amounts', () => {
    const listing={...auctions[0],currentBid:59600000,minBidMeat:1500,instantPurchasePrice:6200000000};
    const cards=render('/auctions',[listing],{id:'buyer'});
    assert.match(cards,/Bid: <\/span>59.6m Meat/);
    assert.match(cards,/>59.6m Meat<\/p>/);
    assert.match(cards,/>Place Bid<\/button>/);
    assert.match(cards,/Buyout: 6.2b/);
    assert.doesNotMatch(cards,/>Buy Now<\/button>|<dialog/);
    assert.doesNotMatch(cards,/For the entire listing|A bid reaching this amount|Instant Purchase Price/);
    const escrowCards=render('/auctions',[{...listing,escrowMode:true}],{id:'buyer'});
    assert.match(escrowCards,/>Place Bid<\/button>/);
    assert.doesNotMatch(escrowCards,/Use the same BID command/);
    const details=render('/auction/active',[listing],{id:'buyer'});
    assert.match(details,/>59,600,000 Meat<\/p>/);
    assert.match(details,/>6,200,000,000 Meat<\/p>/);
    assert.match(details,/>Buy Now<\/button>/);
    const home=render('/',[listing]);
    assert.match(home,/>59.6m Meat<\/p>/);
    assert.match(home,/Buyout Price: 6.2b/);
});


test('My Account renders consistently with a trailing slash', () => {
    const user = { id: 'seller', khubUsername: 'Seller' };
    assert.equal(render('/profile/', auctions, user), render('/profile', auctions, user));
});

test('unknown routes display a useful fallback without requesting auction data', () => {
    for (const path of ['/does-not-exist', '/profile/unknown', '/auction/example/unknown']) {
        const html = render(path, []);
        assert.match(html, /404/);
        assert.match(html, /Page not found/);
        assert.match(html, /href="\/"/);
        assert.match(html, /href="\/auctions"/);
        assert.doesNotMatch(html, /Nothing here yet/);
    }
});


test('active seller controls remain available without a separate status card in either trade mode', () => {
    for (const escrowMode of [true, false]) {
        const listing = { ...auctions[0], escrowMode };
        const seller = render('/auction/active', [listing], { id: 'seller' });
        assert.match(seller, /Cancel this listing/);
        assert.match(seller, /This is your listing\. You may cancel before the first bid\./);
        assert.ok(seller.indexOf('aria-label="Auction bidding"') < seller.indexOf('Cancel this listing'));
        assert.ok(seller.indexOf('This is your listing.') < seller.indexOf('Cancel this listing'));
        assert.match(seller, />Live<\/span>/);
        assert.ok(seller.indexOf('Sold by:') < seller.indexOf('>Live</span>'));
        assert.ok(seller.indexOf('>Live</span>') < seller.indexOf('Ends in'));
        const expired = render('/auction/active', [{ ...listing, endTime: Date.now() - 1000 }], { id: 'buyer' });
        assert.doesNotMatch(expired, />Live<\/span>/);
        assert.doesNotMatch(expired, /aria-label="Auction bidding"/);
        assert.doesNotMatch(seller, /<h2[^>]*>Active<\/h2>/);
        assert.doesNotMatch(render('/auction/active', [listing], { id: 'buyer' }), /Cancel this listing/);
        assert.doesNotMatch(render('/auction/active', [{ ...listing, currentBid: 200, highestBidderId: 'buyer' }], { id: 'seller' }), /Cancel this listing/);
        const withBids = render('/auction/active', [{ ...listing, currentBid: 200, highestBidderId: 'buyer' }], { id: 'seller' });
        assert.match(withBids, /This is your listing\./);
        assert.doesNotMatch(withBids, /You may cancel before the first bid/);
        const cancelled = render('/auction/active', [{ ...listing, status: 'cancelled' }], { id: 'seller' });
        assert.match(cancelled, /aria-label="Auction (?:escrow|outcome)"/);
        assert.doesNotMatch(cancelled, />Live<\/span>/);
    }
});


test('compact browse cards show minimums, private owner indicators and inline bidding triggers without seller metadata', () => {
    const listing = { ...auctions[0], auctionNumber: '1234', image: '/item.gif', item: 'A very long item name that needs two lines', quantity: 2500 };
    for (const escrowMode of [true, false]) {
        const buyer = render('/auctions', [{ ...listing, escrowMode }], { id: 'buyer' });
        assert.match(buyer, /Min: <\/span>100 Meat/);
        assert.match(buyer, /aria-expanded="false"/);
        assert.match(buyer, /href="\/auction\/active"/);
        assert.doesNotMatch(buyer, /Sold by|Auction #1234|More Info|Your Listing/);
        const owner = render('/auctions', [{ ...listing, escrowMode }], { id: 'seller' });
        assert.match(owner, /Your Listing/);
        assert.doesNotMatch(owner, />Place Bid<\/button>|<dialog/);
        const withoutBids = render('/auctions', [{ ...listing, escrowMode }]);
        assert.match(withoutBids, />Place Bid<\/button>/);
    }
});


test('Info explains marginal seller fees and displays the five agreed fee tiers', () => {
    const html = render('/info', []);
    const table = html.match(/<table[^>]*>\s*<caption[^>]*>Tiered escrow seller commission[\s\S]*?<\/table>/)[0];
    assert.equal((table.match(/<tr/g) || []).length, 6);
    for (const rate of ['5%', '4%', '3%', '2%', '1%']) assert.ok(table.includes(rate));
    assert.match(html, /Each rate applies only to the portion within that tier/);
    assert.match(html, /410k Meat total \(4.1%\)/);
    assert.match(html, /rounded down to whole Meat/);
    assert.doesNotMatch(html, /7\.5%/);
});
