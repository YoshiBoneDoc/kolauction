import test from 'node:test';
import assert from 'node:assert/strict';
import { switchProfileTab } from '../src/lib/profileTabScroll.js';
function switchAt({initial = 1200, nextHeight = 200, viewportHeight = 800} = {}) {
    const sectionTop = 600, moves = [];
    let height = 1600, commits = 0;
    const activity = { style:{},getBoundingClientRect:() => ({top:sectionTop-viewport.scrollY}) };
    const viewport = {scrollY:initial,scrollX:0,innerHeight:viewportHeight,scrollTo(options) {
        const offset = Number(activity.style.minHeight?.match(/\+ (\d+)px/)?.[1] || 0);
        const documentHeight = sectionTop + Math.max(height,activity.style.minHeight ? viewportHeight + offset : 0);
        this.scrollY = Math.min(options.top,documentHeight-viewportHeight);moves.push(options);
    }};
    switchProfileTab({activity,viewport,commit:() => {
        assert.equal(activity.style.minHeight,`calc(100dvh + ${Math.max(0,initial-sectionTop)}px)`,'reserve space before content disappears');
        height = nextHeight;commits++;
    }});
    return {activity,viewport,moves,commits};
}
test('short tabs preserve the screen position using space beneath their content', () => {
    const h = switchAt();
    assert.equal(h.viewport.scrollY,1200);assert.equal(h.commits,1);
    assert.equal(h.moves.length,1);assert.equal(h.moves[0].behavior,'instant');
});
test('long tabs preserve offsets both above and below the activity heading', () => {
    assert.equal(switchAt({initial:300,nextHeight:1800}).viewport.scrollY,300);
    assert.equal(switchAt({initial:1500,nextHeight:1800}).viewport.scrollY,1500);
});
test('empty tabs preserve the same position on small mobile viewports', () => {
    const h = switchAt({nextHeight:0,viewportHeight:500});
    assert.equal(h.viewport.scrollY,1200);
    assert.equal(h.activity.style.minHeight,'calc(100dvh + 600px)');
});
test('a missing activity node still commits the tab change without scrolling', () => {
    let committed = false;
    switchProfileTab({activity:null,commit:() => {committed = true;},viewport:{scrollTo() {assert.fail('unexpected scroll');}}});
    assert.equal(committed,true);
});
