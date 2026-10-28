import test from 'node:test';
import assert from 'node:assert/strict';
import { attachCarouselDrag } from '../src/lib/carouselDrag.js';
import { rotateAuctionQueueBySteps } from '../src/lib/auctionCarousel.js';

function fixture(options = {}) {
    function target() {
        const handlers = new Map();
        return { handlers, addEventListener: (name, run) => handlers.set(name, run), removeEventListener: name => handlers.delete(name) };
    }
    let clock = 0, frameId = 0;
    const frames = new Map(), captures = new Set();
    const view = { ...target(), performance: { now: () => clock }, getComputedStyle: () => ({ columnGap: '16px' }),
        requestAnimationFrame(run) { frames.set(++frameId, run); return frameId; }, cancelAnimationFrame(id) { frames.delete(id); } };
    const viewport = { ...target(), ownerDocument: { defaultView: view }, dataset: {}, clientWidth: 600, scrollWidth: 1200, scrollLeft: 0,
        setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
    const track = { style: {}, firstElementChild: { getBoundingClientRect: () => ({ width: 284 }) },
        getAnimations: () => [{ effect: { getComputedTiming: () => ({ progress: 0.5 }) } }] };
    const state = { order: ['a', 'b', 'c', 'd'], elapsed: 0 };
    const stop = attachCarouselDrag({ viewport, track, moving: true, reducedMotion: false,
        rotate: steps => { state.order = rotateAuctionQueueBySteps(state.order, steps); }, onElapsed: elapsed => { state.elapsed = elapsed; }, ...options });
    function emit(where, type, props = {}) {
        const event = { type, isPrimary: true, pointerType: 'mouse', button: 0, pointerId: 1, clientX: 0, clientY: 0,
            timeStamp: clock, detail: 1, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
        where.handlers.get(type)?.(event); return event;
    }
    return { viewport, track, view, state, frames, stop, emit,
        tick(ms) { clock += ms; const pending = [...frames.values()]; frames.clear(); pending.forEach(run => run(clock)); } };
}

test('horizontal dragging wraps multiple tiles in both directions without duplicate cards', () => {
    const h = fixture();
    h.emit(h.viewport, 'pointerdown');
    h.emit(h.viewport, 'pointermove', { clientX: 750, timeStamp: 100 });
    assert.equal(h.viewport.dataset.dragging, 'true');
    assert.deepEqual(h.state.order, ['b', 'c', 'd', 'a']);
    assert.equal(h.state.elapsed, 0);
    assert.equal(h.track.style.animation, 'none');
    h.emit(h.viewport, 'pointermove', { clientX: 0, timeStamp: 200 });
    assert.deepEqual(h.state.order, ['a', 'b', 'c', 'd']);
    assert.equal(new Set(h.state.order).size, 4);
    h.emit(h.view, 'pointercancel', { timeStamp: 210 });
    assert.equal(h.track.style.animation, '');
    assert.equal(h.frames.size, 0);
    h.stop();
});

test('ordinary taps and vertical gestures keep native behavior; horizontal drags suppress only pointer clicks', () => {
    const h = fixture();
    h.emit(h.viewport, 'pointerdown'); h.emit(h.view, 'pointerup');
    assert.equal(h.emit(h.viewport, 'click').prevented, false);
    h.emit(h.viewport, 'pointerdown');
    assert.equal(h.emit(h.viewport, 'pointermove', { clientX: 2, clientY: 30 }).prevented, false);
    h.emit(h.view, 'pointerup'); assert.equal(h.emit(h.viewport, 'click').prevented, false);
    h.emit(h.viewport, 'pointerdown'); h.emit(h.viewport, 'pointermove', { clientX: 80, timeStamp: 20 });
    h.emit(h.view, 'pointerup', { timeStamp: 21 });
    assert.equal(h.emit(h.viewport, 'click').prevented, true);
    assert.equal(h.emit(h.viewport, 'click', { detail: 0 }).prevented, false);
    h.emit(h.viewport, 'pointerdown'); h.emit(h.view, 'pointerup');
    assert.equal(h.emit(h.viewport, 'click').prevented, false);
    h.tick(500); assert.equal(h.emit(h.viewport, 'click').prevented, false);
    h.stop(); assert.equal(h.frames.size, 0); assert.equal(h.viewport.handlers.size, 0); assert.equal(h.view.handlers.size, 0);
});

test('quick drags coast and settle back to automatic motion; reduced-motion dragging remains stationary after release', () => {
    const h = fixture();
    h.emit(h.viewport, 'pointerdown'); h.emit(h.viewport, 'pointermove', { clientX: 100, timeStamp: 20 });
    h.emit(h.view, 'pointerup', { timeStamp: 21 });
    const released = h.state.elapsed;
    h.tick(16); assert.notEqual(h.state.elapsed, released);
    for (let i = 0; i < 75; i++) h.tick(16);
    assert.equal(h.frames.size, 0); assert.equal(h.track.style.animation, ''); h.stop();
    const reduced = fixture({ moving: false, reducedMotion: true });
    reduced.emit(reduced.viewport, 'pointerdown'); reduced.emit(reduced.viewport, 'pointermove', { clientX: -100, timeStamp: 20 });
    reduced.emit(reduced.view, 'pointerup', { timeStamp: 21 });
    assert.equal(reduced.viewport.scrollLeft, 100); assert.equal(reduced.frames.size, 0); reduced.stop();
});


test('static strips leave touch swipes native without capture, custom momentum or accidental click blocking',()=>{
    const h=fixture({moving:false});
    h.emit(h.viewport,'pointerdown',{pointerType:'touch'});
    const move=h.emit(h.viewport,'pointermove',{pointerType:'touch',clientX:-500,clientY:35,timeStamp:80});
    assert.equal(move.prevented,false);assert.equal(h.viewport.dataset.dragging,undefined);
    assert.equal(h.viewport.scrollLeft,0); // Browser owns scrolling; helper never resets it.
    h.viewport.scrollLeft=450;
    h.emit(h.view,'pointercancel',{pointerType:'touch',timeStamp:90});
    assert.equal(h.viewport.scrollLeft,450);assert.equal(h.frames.size,0);
    assert.equal(h.emit(h.viewport,'click').prevented,false);
    h.stop();
});

test('animated strips follow horizontal trackpad momentum and resume their loop after scrolling settles',()=>{
    const h=fixture();
    const start=[...h.state.order];
    assert.equal(h.emit(h.viewport,'wheel',{deltaX:700,deltaY:0}).prevented,true);
    assert.equal(h.track.style.animation,'none');
    assert.notDeepEqual(h.state.order,start);
    assert.equal(new Set(h.state.order).size,4);
    h.tick(150);
    assert.equal(h.track.style.animation,'none');
    h.emit(h.viewport,'wheel',{deltaX:20,deltaY:0});
    h.tick(150);assert.equal(h.track.style.animation,'none');
    h.tick(100);assert.equal(h.track.style.animation,'');
    assert.equal(h.frames.size,0);
    assert.equal(h.emit(h.viewport,'wheel',{deltaX:0,deltaY:80}).prevented,false);
    assert.equal(h.emit(h.viewport,'wheel',{deltaX:80,deltaY:0,ctrlKey:true}).prevented,false);
    assert.equal(h.emit(h.viewport,'wheel',{deltaX:0,deltaY:80,shiftKey:true}).prevented,true);
    h.stop();assert.equal(h.frames.size,0);
    const native=fixture({moving:false});
    assert.equal(native.emit(native.viewport,'wheel',{deltaX:80,deltaY:0}).prevented,false);
    native.stop();
});

test('static strips retain desktop dragging and momentum while touch scrolling remains independent',()=>{
    const h=fixture({moving:false});
    h.emit(h.viewport,'pointerdown');h.emit(h.viewport,'pointermove',{clientX:-150,timeStamp:20});
    h.emit(h.view,'pointerup',{timeStamp:21});assert.equal(h.viewport.scrollLeft,150);
    h.tick(16);assert.ok(h.viewport.scrollLeft>150);
    const before=h.viewport.scrollLeft;
    h.emit(h.viewport,'pointerdown',{pointerType:'touch'});assert.equal(h.frames.size,0);
    h.emit(h.viewport,'pointermove',{pointerType:'touch',clientX:-300,timeStamp:50});
    assert.equal(h.viewport.scrollLeft,before);h.stop();
});
