import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import { Link, StaticRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { loyaltyProgress, parseLoyaltySales, readLoyaltySales } from '../src/lib/loyaltyProgress.js';
import { getLeaderboardFeeBenefits, leaderboardFeeBenefits } from '../src/lib/leaderboardFeePreview.js';
import { loyaltyTiers, previewTierForEscrowSales } from '../src/lib/loyaltyPreview.js';

test('preview membership changes at each inclusive completed escrow sales milestone', () => {
    for (let i = 1; i < loyaltyTiers.length; i++) {
        const tier = loyaltyTiers[i];
        assert.equal(previewTierForEscrowSales(tier.minimum - 1).name, loyaltyTiers[i - 1].name);
        assert.equal(previewTierForEscrowSales(tier.minimum).name, tier.name);
    }
    assert.equal(previewTierForEscrowSales(0).name, 'Base');
});

const { outputFiles } = buildSync({ stdin: { contents: "export { LeaderboardsPanel as default } from './src/pages/Leaderboards.jsx'; export { LoyaltyProgressPanel } from './src/components/LoyaltyProgress.jsx';",
    resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'jsx' }, bundle: true,
    write: false, platform: 'node', format: 'cjs', packages: 'external', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'import.meta.env': '{}' } });
const require = createRequire(import.meta.url);
let slots, cursor;
const compiled = { exports: {} };
new Function('require', 'module', 'exports', outputFiles[0].text)(name => name === 'react' ? { ...React,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
        return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
} : require(name), compiled, compiled.exports);
const playerNames = ['MeatMagnate', 'DiscoBandit', 'PastamancerPrime', ...Array.from({length:7}, (_, i) => `Trader${i}`)];
const donorNames = ['GenerousGnome', 'MeatPatron', 'KindheartedKol', ...Array.from({length:7}, (_, i) => `Donor${i}`)];
const fixtureRows = (names, values) => names.map((name, i) => ({id:name, name, rank:i+1, value:values[i] ?? BigInt(100-i)}));
const leaderboardFixture = {refreshedAt:'2026-11-13T12:00:00Z',personal:{volume:123400000n,trades:42n,donors:500n},
    volume:fixtureRows(playerNames, [18420000000n,12860000000n,9750000000n]),
    trades:fixtureRows([playerNames[0],playerNames[2],playerNames[1],...playerNames.slice(3)], [1248n,1102n,986n]),
    donors:fixtureRows(donorNames, [125000000n,70000000n,35000000n]),
};
const nodes = tree => !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(nodes)];

test('hover and keyboard previews restore earned Gold benefits without changing actual fills', () => {
    slots = []; let tree;
    const render = () => { cursor = 0; tree = compiled.exports.LoyaltyProgressPanel({ sales:750_000_000n, signedIn:true }); return nodes(tree); };
    const rates = () => nodes(tree).filter(node=>node.type==='dd').map(node=>node.props.children[0]);
    let all = render();
    const fills = () => nodes(tree).filter(node=>node.props?.className==='club-tier-fill').map(node=>node.props.style.width);
    const actualFills = fills();
    assert.deepEqual(rates(), loyaltyTiers[2].rates);
    const html = renderToStaticMarkup(React.createElement(StaticRouter, null, tree));
    assert.match(html, /Current: <span class="club-benefit-tier-name">Gold<\/span>/);assert.doesNotMatch(html, /66.7%/);assert.match(html, /250M to Platinum/);
    assert.match(html, /Only completed escrow sales count toward your loyalty tier./);
    for (const tier of loyaltyTiers) {
        const button = all.find(node=>node.type==='button' && node.props['aria-label']?.startsWith(tier.name+','));
        button.props.onMouseEnter();all=render();
        assert.deepEqual(rates(),tier.rates);assert.deepEqual(fills(),actualFills);
        const current=nodes(tree).find(node=>node.props?.className?.includes('is-current'));
        assert.ok(current.props['aria-label'].startsWith('Gold,'));
        assert.ok(current.props.className.includes('bg-transparent'));
        assert.ok(nodes(tree).some(node=>node.props?.className?.includes('is-previewing')));
        button.props.onMouseLeave();all=render();
        assert.deepEqual(rates(),loyaltyTiers[2].rates);
        button.props.onFocus();all=render();assert.deepEqual(rates(),tier.rates);
        button.props.onBlur();all=render();assert.deepEqual(rates(),loyaltyTiers[2].rates);
    }
});

test('sales summary stays in the sidebar and leaving a preview restores current benefits', () => {
    slots=[];let tree;
    const render=()=>{cursor=0;tree=compiled.exports.LoyaltyProgressPanel({sales:102_300_000n,signedIn:true});return nodes(tree);};
    let all=render();
    const html=renderToStaticMarkup(React.createElement(StaticRouter,null,tree));
    assert.match(html,/102.3M Lifetime escrow sales/);assert.match(html,/97.7M to Gold/);
    assert.doesNotMatch(html,/Coming soon|Refresh progress|Meat earned|sales required/);
    assert.ok(all.findIndex(node=>node.props?.className==='club-sales-summary') > all.findIndex(node=>node.props?.className==='club-tier-track'));
    const diamond=all.find(node=>node.props?.['aria-label']?.startsWith('Diamond,'));
    diamond.props.onClick();all=render();
    const heading=all.find(node=>node.props?.className==='club-benefit-heading');
    assert.ok(!nodes(heading).some(node=>node.type==='button'));
    assert.equal(nodes(heading).find(node=>node.props?.className==='club-benefit-tier-name').props.children,'Diamond');
    diamond.props.onMouseLeave();all=render();
    assert.deepEqual(all.filter(node=>node.type==='dd').map(node=>node.props.children[0]),loyaltyTiers[1].rates);
});

test('unknown progress never claims a tier or a zero balance', () => {
    for (const props of [{signedIn:false}, {signedIn:true,loading:true}, {signedIn:true,error:'Unavailable'}]) {
        slots=[];cursor=0;
        const tree=compiled.exports.LoyaltyProgressPanel(props);
        assert.ok(!nodes(tree).some(node=>node.props?.role==='progressbar'));
        assert.ok(!nodes(tree).some(node=>node.props?.className?.includes('is-current')));
    }
});

test('progress uses the interval toward the next tier and caps all segments at Diamond', () => {
    const progress=loyaltyProgress(750_000_000n);
    assert.equal(progress.earnedIndex,2);assert.equal(progress.remaining,250_000_000n);
    assert.deepEqual(progress.fills,[100,100,100,68.75,0]);
    assert.equal(loyaltyProgress(0n).earnedIndex,0);
    assert.equal(loyaltyProgress(50_000_000n).earnedIndex,1);
    assert.deepEqual(loyaltyProgress(9_000_000_000_000_000_000n).fills,[100,100,100,100,100]);
    assert.equal(loyaltyProgress(3_000_000_000n).next,undefined);
});

test('private progress validates totals exactly and surfaces failures', async () => {
    assert.equal(parseLoyaltySales({completed_escrow_sales_meat:'9007199254740993123'}),9007199254740993123n);
    for(const value of [undefined,null,-1,0,'-1','NaN','1.5']) assert.throws(()=>parseLoyaltySales({completed_escrow_sales_meat:value}));
    const calls=[];
    const client={rpc(name){calls.push(name);return {data:{completed_escrow_sales_meat:'750000000'}};}};
    assert.equal(await readLoyaltySales(client),750000000n);
    assert.deepEqual(calls,['read_my_loyalty_progress']);
    await assert.rejects(readLoyaltySales({rpc:()=>({error:{message:'private error'}})}),/could not be loaded/);
});

test('leaderboard category and search controls remain available', () => {
    slots=[];cursor=0;let tree=compiled.exports.default({ data: leaderboardFixture, signedIn: true });
    nodes(tree).find(node=>node.type==='button' && node.props.children==='Top donors').props.onClick();
    cursor=0;tree=compiled.exports.default({ data: leaderboardFixture, signedIn: true });
    assert.ok(!nodes(tree).some(node=>node.props?.className==='club-donor-note'));
    assert.ok(nodes(tree).some(node=>node.type==='input' && node.props['aria-label']==='Search leaderboard players'));
});

test('podium awards follow each benchmark and leave seven unbadged table players', () => {
    for (const [category, expectedNames, expectedTotal] of [
        ['Meat traded', ['MeatMagnate', 'DiscoBandit', 'PastamancerPrime'], '18.42B'],
        ['Total trades', ['MeatMagnate', 'PastamancerPrime', 'DiscoBandit'], '1,248'],
        ['Top donors', ['GenerousGnome', 'MeatPatron', 'KindheartedKol'], '125M'],
    ]) {
        slots=[];cursor=0;let tree=compiled.exports.default({ data: leaderboardFixture, signedIn: true });
        nodes(tree).find(node=>node.type==='button' && node.props.children===category).props.onClick();
        cursor=0;tree=compiled.exports.default({ data: leaderboardFixture, signedIn: true });
        const all=nodes(tree);
        const personal=all.find(node=>node.props?.className==='club-personal-total');
        assert.equal(personal.props.children, category==='Total trades' ? '42' : category==='Top donors' ? '500 Meat' : '123,400,000 Meat');
        const podium=all.find(node=>node.type==='ol');
        assert.deepEqual(nodes(podium).filter(node=>node.props?.className==='club-podium-person').map(node=>nodes(node).find(child=>child.type===Link).props.children),expectedNames);
        assert.equal(nodes(podium).find(node=>node.props?.className==='club-podium-total').props.children,expectedTotal);
        assert.equal(nodes(podium).filter(node=>node.props?.['aria-label']==='First place crown').length,1);
        assert.equal(nodes(podium).filter(node=>node.props?.className==='club-podium-trophy').length,2);
        assert.equal(all.filter(node=>node.type===Link && node.props.to?.startsWith('/seller/')).length,10);
        const body=all.find(node=>node.type==='tbody');
        assert.equal(nodes(body).filter(node=>node.type==='tr').length,7);
        const html=renderToStaticMarkup(React.createElement(StaticRouter,null,body));
        assert.doesNotMatch(html,/club-avatar|club-volume-bar|Diamond|Gold|Silver|Community supporter/);
    }
});

test('guest, loading and failed reads never render placeholder podiums', () => {
    for (const props of [{signedIn:false}, {signedIn:true,loading:true}, {signedIn:true,error:'Unavailable'}]) {
        slots=[];cursor=0;
        const all=nodes(compiled.exports.default(props));
        assert.ok(!all.some(node=>node.type==='ol' || node.type==='tbody'));
    }
    slots=[];cursor=0;
    const tree=compiled.exports.default({data:{...leaderboardFixture,volume:[]},signedIn:true});
    const board=nodes(tree).find(node=>node.props?.className==='club-panel club-board');
    const html=renderToStaticMarkup(React.createElement(StaticRouter,null,board));
    assert.match(html,/No qualifying players yet/);
    assert.doesNotMatch(html,/Sample|Illustrative|lifetime total/);
});

test('remote search shows a player beyond the top ten with their overall rank', () => {
    slots=[];cursor=0;
    const onSearch=()=>{};
    let tree=compiled.exports.default({data:leaderboardFixture,signedIn:true,onSearch});
    nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'Outside'}});
    cursor=0;
    tree=compiled.exports.default({data:leaderboardFixture,signedIn:true,onSearch,searchState:{query:'Outside',category:'volume',offset:0,more:false,rows:[{id:'outside',name:'Outside',value:12345n,rank:47}]}});
    const all=nodes(tree);
    assert.ok(!all.some(node=>node.type==='ol'));
    assert.equal(all.find(node=>node.props?.className==='club-rank').props.children,'47');
    assert.equal(all.find(node=>node.type===Link && node.props.to==='/seller/outside').props.children,'Outside');
});

test('zero-activity search displays a dash for rank and zero for the stat', () => {
    slots=[];cursor=0;const onSearch=()=>{};
    let tree=compiled.exports.default({data:leaderboardFixture,signedIn:true,onSearch});
    nodes(tree).find(node=>node.type==='input').props.onChange({target:{value:'Zero'}});
    cursor=0;
    tree=compiled.exports.default({data:leaderboardFixture,signedIn:true,onSearch,searchState:{query:'Zero',category:'volume',offset:0,more:false,rows:[{id:'zero',name:'Zero',value:0n,rank:null}]}});
    assert.equal(nodes(tree).find(node=>node.props?.className==='club-rank').props.children,'—');
    assert.equal(nodes(tree).find(node=>node.type==='td').props.children,'0');
});

test('leaderboard benefits choose the best trader position, with donor waiver precedence', () => {
    const data={volume:[{id:'me',rank:3}],trades:[{id:'me',rank:1}],donors:[]};
    assert.equal(getLeaderboardFeeBenefits(data,'me'),leaderboardFeeBenefits.leader);
    data.trades[0].rank=2;
    assert.equal(getLeaderboardFeeBenefits(data,'me'),leaderboardFeeBenefits.top3);
    data.donors=[{id:'me',rank:1}];
    assert.deepEqual(getLeaderboardFeeBenefits(data,'me').rates,[0,0,0,0]);
    assert.equal(getLeaderboardFeeBenefits(data,'other'),null);
    assert.equal(getLeaderboardFeeBenefits({volume:[{id:'me',rank:7}],trades:[],donors:[]},'me'),null);
});

test('leaderboard and donor defaults restore after tier preview without changing progress', () => {
    for (const benefit of Object.values(leaderboardFeeBenefits)) {
        slots=[];let tree;
        const render=()=>{cursor=0;tree=compiled.exports.LoyaltyProgressPanel({sales:102300000n,signedIn:true,leaderboardBenefit:benefit});return nodes(tree);};
        let all=render();
        const rates=()=>nodes(tree).filter(node=>node.type==='dd').map(node=>node.props.children[0]);
        const fills=()=>nodes(tree).filter(node=>node.props?.className==='club-tier-fill').map(node=>node.props.style.width);
        const actual=fills();
        assert.deepEqual(rates(),benefit.rates);
        assert.match(renderToStaticMarkup(tree),new RegExp(benefit.label));
        const gold=all.find(node=>node.props?.['aria-label']?.startsWith('Gold,'));
        gold.props.onMouseEnter();all=render();
        assert.deepEqual(rates(),loyaltyTiers[2].rates);assert.deepEqual(fills(),actual);
        gold.props.onMouseLeave();all=render();
        assert.deepEqual(rates(),benefit.rates);assert.deepEqual(fills(),actual);
        gold.props.onFocus();all=render();assert.deepEqual(rates(),loyaltyTiers[2].rates);
        gold.props.onBlur();all=render();assert.deepEqual(rates(),benefit.rates);
    }
});

test('benefits use actual eligibility without temporary scenario controls', () => {
    for (const [viewerId, expected] of [['MeatMagnate',leaderboardFeeBenefits.leader], ['DiscoBandit',leaderboardFeeBenefits.top3], ['GenerousGnome',leaderboardFeeBenefits.donor], ['other',null]]) {
        slots=[];cursor=0;
        const tree=compiled.exports.default({data:leaderboardFixture,signedIn:true,viewerId});
        const all=nodes(tree);
        assert.deepEqual(all.find(node=>node.props && 'leaderboardBenefit' in node.props).props.leaderboardBenefit,expected);
        assert.ok(!all.some(node=>node.props?.['aria-label']==='Preview leaderboard fee benefits'));
    }
});
