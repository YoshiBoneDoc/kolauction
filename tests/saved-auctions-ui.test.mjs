import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import * as React from 'react';
const require = createRequire(import.meta.url);
const { outputFiles } = buildSync({ stdin: { contents: "export {default} from './src/components/SavedAuctions.jsx';", resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', define: { 'import.meta.env': '{}' },
    external: ['../lib/supabase','../lib/privateRefresh','../hooks/useAuctionBoundaryNow','./RemainingTime'] });
let defaultMinutes = 0;
let active, user, rows, rejectWrite = false;
const effects = [], writes = [];
function state(initial) {
    const h = active, i = h.cursor++;
    if (!(i in h.slots)) h.slots[i] = typeof initial === 'function' ? initial() : initial;
    return [h.slots[i], value => { h.slots[i] = typeof value === 'function' ? value(h.slots[i]) : value; }];
}
const client = { rpc(name, args) {
    if (name === 'read_saved_auctions') return { abortSignal: async () => ({ data: { rows: rows.filter(row => !args.p_id || row.id === args.p_id), default_reminder_minutes: defaultMinutes } }) };
    writes.push(args);
    if (rejectWrite) return Promise.resolve({ error: {} });
    if (name === 'set_saved_reminder_default') {
        defaultMinutes = args.p_minutes;
        if (args.p_apply_all) rows = rows.map(row => ({...row,reminder_minutes:defaultMinutes}));
        return Promise.resolve({error:null});
    }
    const old = rows.find(row => row.id === args.p_id);
    rows = rows.filter(row => row.id !== args.p_id);
    if (args.p_saved) rows.push({ ...old, id: args.p_id, item: 'Test bundle', status: 'active', end_time: new Date(Date.now()+3600000).toISOString(), reminder_minutes: args.p_minutes ?? old?.reminder_minutes ?? defaultMinutes });
    return Promise.resolve({ error: null });
} };
const compiled = { exports: {} };
new Function('require','module','exports',outputFiles[0].text)(name => name === 'react' ? { ...React, useState: state,
    useRef: value => state({ current: value })[0], useContext: () => ({ currentUser: user }),
    useEffect(fn, deps) { const [previous, set] = state(null); if (!previous || deps.some((v,i) => previous[i] !== v)) { set(deps);effects.push(fn); } },
} : name === '../lib/supabase' ? { supabase: client }
    : name === '../lib/privateRefresh' ? { startPrivateRefresh: ({refresh}) => { void refresh();return () => {}; } }
        : name === '../hooks/useAuctionBoundaryNow' ? { useAuctionBoundaryNow: () => Date.now() }
            : name === './RemainingTime' ? () => '1h left'
                : name === 'react-router-dom' ? { Link: ({to, children, ...props}) => React.createElement('a',{...props,href:to},children) } : require(name),compiled,compiled.exports);
function harness(props = {}) {
    const instances = new Map(), cleanups = [];
    function visit(element, path = '') {
        if (Array.isArray(element)) return element.flatMap((child,i) => visit(child,`${path}.${child?.key || i}`));
        if (!element || typeof element !== 'object') return [];
        if (typeof element.type === 'function') {
            const key = `${path}:${element.type.name}:${element.key}`;
            if (!instances.has(key)) instances.set(key,{slots:[],cursor:0});
            active = instances.get(key);active.cursor = 0;
            return visit(element.type(element.props),key);
        }
        return [element,...visit(React.Children.toArray(element.props?.children),path)];
    }
    return { render() { this.nodes = visit(React.createElement(compiled.exports.default,props));for (const fn of effects.splice(0)) { const cleanup = fn();if (cleanup) cleanups.push(cleanup); }return this; },
        find(predicate) { return this.nodes.find(predicate); },
        close() { for (const cleanup of cleanups) cleanup(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('detail and Profile controls share saved state, persist preferences, allow changes after a reminder, and retain state on failure', async () => {
    const previous = {window:globalThis.window,document:globalThis.document};globalThis.document = {};globalThis.window = new EventTarget();
    defaultMinutes = 0;rows = [];writes.length = 0;user = {id:'owner'};
    const detail = harness({auctionId:'auction'}), profile = harness();
    try {
        detail.render();profile.render();await settle();detail.render();profile.render();
        const bookmark = detail.find(n => n.type === 'button' && n.props?.['aria-label'] === 'Save auction');
        assert.equal(bookmark.props.title, 'Save auction');
        assert.match(bookmark.props.className, /absolute right-2 -top-px/);
        assert.match(bookmark.props.className, /border-0 bg-transparent/);
        assert.equal(React.Children.toArray(bookmark.props.children).length, 1, 'icon only, without button text');
        assert.equal(bookmark.props.children.props.fill, 'var(--auction-bookmark-fill)');
        assert.equal(bookmark.props.children.props.stroke, '#85172D');
        assert.equal(bookmark.props.children.props.viewBox, '0 0 28 38');
        assert.match(bookmark.props.children.props.className, /h-\[38px\] w-7/);
        await bookmark.props.onClick();
        await settle();detail.render();profile.render();
        const savedBookmark = detail.find(n => n.type === 'button' && n.props?.['aria-label'] === 'Remove from saved');
        assert.equal(savedBookmark.props.title, 'Remove from saved');
        assert.equal(savedBookmark.props['aria-pressed'], true);
        assert.equal(savedBookmark.props.children.props.stroke, '#85172D');
        assert.ok(profile.find(n => n.props?.href === '/auction/auction'));
        assert.equal(detail.find(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder'), undefined, 'reminder controls belong only in Profile');
        await profile.find(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder').props.onChange({target:{value:'360'}});
        await settle();detail.render();profile.render();assert.equal(profile.find(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder').props.value,360);
        assert.equal(detail.find(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder'), undefined);
        rows[0].reminder_attempted = true;rows[0].reminder_outcome = 'sent';window.dispatchEvent(new Event('khub:saved-auctions-changed'));
        await settle();profile.render();assert.equal(profile.find(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder').props.disabled,false);
        rejectWrite = true;
        await detail.find(n => n.type === 'button' && n.props?.['aria-label'] === 'Remove from saved').props.onClick();detail.render();
        assert.ok(detail.find(n => n.type === 'button' && n.props?.['aria-label'] === 'Remove from saved'));
        assert.ok(detail.find(n => n.props?.role === 'status'));
        rejectWrite = false;
        await profile.find(n => n.type === 'button' && n.props['aria-label'] === 'Remove from saved').props.onClick();
        await settle();detail.render();assert.ok(detail.find(n => n.type === 'button' && n.props?.['aria-label'] === 'Save auction'));
        user = null;assert.equal(harness().render().nodes.length,0);
    } finally {detail.close();profile.close();globalThis.window = previous.window;globalThis.document = previous.document;rejectWrite = false;}
});
test('saved rows keep reminder preferences aligned and expand five more at a time', async () => {
    const previous = {window:globalThis.window,document:globalThis.document};
    globalThis.window = new EventTarget();globalThis.document = {};user = {id:'owner'};
    const preferences = [0,5,15,30,60,360,720,1440,0,5,15];
    rows = preferences.map((minutes,i) => ({id:`saved-${i}`,item:`Saved item ${i}`,status:'active',end_time:new Date(Date.now()+3600000).toISOString(),reminder_minutes:minutes}));
    const profile = harness();
    try {
        profile.render();await settle();profile.render();
        const selects = () => profile.nodes.filter(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder');
        assert.deepEqual(selects().map(n => n.props.value), preferences.slice(0,5));
        profile.find(n => n.props?.className === 'profile-show-more').props.onClick();profile.render();
        assert.deepEqual(selects().map(n => n.props.value), preferences.slice(0,10));
        profile.find(n => n.props?.className === 'profile-show-more').props.onClick();profile.render();
        assert.deepEqual(selects().map(n => n.props.value), preferences);
        profile.find(n => n.props?.className === 'profile-show-more').props.onClick();profile.render();
        assert.equal(selects().length,5);
    } finally {profile.close();globalThis.window = previous.window;globalThis.document = previous.document;}
});

test('default reminders persist, apply to new saves, and Apply to all updates current rows', async () => {
    const previous = {window:globalThis.window,document:globalThis.document};
    globalThis.window = new EventTarget();globalThis.document = {};user = {id:'owner'};rows = [];defaultMinutes = 0;
    const profile = harness(), detail = harness({auctionId:'new-auction'});
    try {
        profile.render();detail.render();await settle();profile.render();detail.render();
        await profile.find(n => n.props?.['aria-label'] === 'Default KMail reminder').props.onChange({target:{value:'15'}});
        await settle();profile.render();detail.render();
        await detail.find(n => n.type === 'button' && n.props['aria-label'] === 'Save auction').props.onClick();
        await settle();profile.render();assert.equal(rows[0].reminder_minutes,15);
        await profile.find(n => n.props?.['aria-label'] === 'Default KMail reminder').props.onChange({target:{value:'60'}});
        await settle();profile.render();assert.equal(rows[0].reminder_minutes,15,'default alone must not overwrite row preferences');
        await profile.find(n => n.type === 'button' && n.props.children === 'Apply to all').props.onClick();
        await settle();profile.render();assert.equal(rows[0].reminder_minutes,60);
    } finally {profile.close();detail.close();globalThis.window = previous.window;globalThis.document = previous.document;}
});
test('saved auction rows share compact listing presentation for Sell, Buy and bundles', async () => {
    const previous = {window:globalThis.window,document:globalThis.document};
    globalThis.window = new EventTarget();globalThis.document = {};user = {id:'owner'};
    rows = [
        {id:'sell',item:'Saved Sell',image:'/test.gif',quantity:'12',auction_kind:'sell',escrow_mode:true,status:'active',end_time:new Date(Date.now()+3600000).toISOString(),current_bid:'0',reminder_minutes:0},
        {id:'buy',item:'Saved Buy',quantity:'100',auction_kind:'buy',escrow_mode:true,status:'active',end_time:new Date(Date.now()+3600000).toISOString(),min_bid_meat:'200',purchased_quantity:'3',reminder_minutes:15},
        {id:'bundle',item:'Bundle: Saved lot',quantity:'1',bundle_items:[{id:1,quantity:2},{id:2,quantity:3}],auction_kind:'sell',escrow_mode:false,status:'completed',final_price:'1000000',reminder_minutes:0},
    ];
    const profile = harness();
    try {
        profile.render();await settle();profile.render();
        assert.ok(profile.find(n => n.type === 'img' && n.props.src === '/test.gif'));
        assert.ok(profile.find(n => n.props?.children === '×12'));
        assert.ok(profile.find(n => n.props?.children === '(5 items)'));
        assert.ok(profile.find(n => n.props?.children === 'No bids yet'));
        assert.ok(profile.find(n => n.type === 'li' && n.props.className.includes('is-buy')));
        assert.equal(profile.nodes.filter(n => n.type === 'select' && n.props['aria-label'] === 'KMail reminder').length,3);
    } finally {profile.close();globalThis.window = previous.window;globalThis.document = previous.document;}
});
