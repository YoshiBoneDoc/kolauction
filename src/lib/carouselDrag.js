import { CAROUSEL_STEP_MS } from './auctionCarousel.js';

// Animated strips use pointer dragging. Static strips leave touch swipes and
// inertia to the browser; desktop mouse/pen dragging still uses this helper.
export function attachCarouselDrag({ viewport, track, moving, reducedMotion, rotate, onElapsed, nativeTouch = !moving }) {
    let gesture = null;
    let manual = false;
    let position = 0;
    let step = 1;
    let frame = 0;
    let suppressClickUntil = 0;
    let disposed = false;
    const view = viewport.ownerDocument.defaultView;
    function measure() {
        step = (track.firstElementChild?.getBoundingClientRect().width || 1)
            + (Number.parseFloat(view.getComputedStyle(track).columnGap) || 0);
    }
    function paint() {
        track.style.transform = `translate3d(${position - step}px, 0, 0)`;
        onElapsed(position / step * CAROUSEL_STEP_MS);
    }
    function beginManual() {
        measure();
        const progress = track.getAnimations()[0]?.effect?.getComputedTiming().progress;
        position = (typeof progress === 'number' ? progress : 0) * step;
        track.style.animation = 'none';
        manual = true;
        paint();
    }
    function moveBy(delta) {
        if (!moving) { viewport.scrollLeft -= delta; return; }
        position += delta;
        const turns = Math.floor(position / step);
        if (turns) { position -= turns * step; rotate(turns); }
        paint();
    }
    function resume() {
        if (!manual) return;
        track.style.animationDelay = `-${position / step * CAROUSEL_STEP_MS}ms`;
        track.style.transform = '';
        track.style.animation = '';
        manual = false;
    }
    function stopMomentum() {
        view.cancelAnimationFrame(frame);
        frame = 0;
        resume();
    }
    function down(event) {
        if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
        if (nativeTouch && event.pointerType === 'touch') {
            // Do not capture/prevent touch gestures on a native scroll container.
            // Browser direction locking and momentum handle long/diagonal swipes.
            gesture = null;
            stopMomentum();
            return;
        }
        if (!moving && viewport.scrollWidth <= viewport.clientWidth + 1) return;
        if (gesture) return;
        suppressClickUntil = 0;
        stopMomentum();
        gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
            lastX: event.clientX, lastTime: event.timeStamp, velocity: 0, dragging: false };
    }
    function move(event) {
        if (!gesture || gesture.id !== event.pointerId) return;
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (!gesture.dragging) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
            if (Math.abs(dy) >= Math.abs(dx)) { gesture = null; return; }
            gesture.dragging = true;
            viewport.setPointerCapture(event.pointerId);
            viewport.dataset.dragging = 'true';
            if (moving) beginManual();
        }
        event.preventDefault();
        const elapsed = Math.max(8, event.timeStamp - gesture.lastTime);
        const velocity = (event.clientX - gesture.lastX) / elapsed;
        gesture.velocity = Math.max(-3, Math.min(3, velocity * 0.7 + gesture.velocity * 0.3));
        moveBy(event.clientX - gesture.lastX);
        gesture.lastX = event.clientX;
        gesture.lastTime = event.timeStamp;
    }
    function up(event) {
        if (!gesture || gesture.id !== event.pointerId) return;
        const previous = gesture;
        gesture = null;
        delete viewport.dataset.dragging;
        if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
        if (!previous.dragging) return;
        suppressClickUntil = view.performance.now() + 400;
        let velocity = event.timeStamp - previous.lastTime > 100 ? 0 : previous.velocity;
        if (event.type === 'pointercancel' || reducedMotion || Math.abs(velocity) < 0.02) { resume(); return; }
        let last = view.performance.now();
        const started = last;
        function coast(time) {
            if (disposed) return;
            const elapsed = Math.min(32, time - last);
            last = time;
            moveBy(velocity * elapsed);
            velocity *= Math.exp(-elapsed / 180);
            if (Math.abs(velocity) > 0.02 && time - started < 1000) frame = view.requestAnimationFrame(coast);
            else { frame = 0; resume(); }
        }
        frame = view.requestAnimationFrame(coast);
    }
    function click(event) {
        // A drag must never open the card beneath the release point; ordinary
        // clicks and keyboard activation keep their normal link behavior.
        if (event.detail !== 0 && view.performance.now() < suppressClickUntil) {
            event.preventDefault(); event.stopPropagation();
        }
    }
    function preventNativeDrag(event) { event.preventDefault(); }
    function wheel(event) {
        // Static strips already get native trackpad scrolling and momentum.
        // For the animated strip, translate those same horizontal deltas into
        // queue movement and resume auto-scrolling after the gesture settles.
        if (!moving || gesture || event.ctrlKey) return;
        const horizontal = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        if (!horizontal || (!event.shiftKey && Math.abs(event.deltaY || 0) >= Math.abs(horizontal))) return;
        event.preventDefault();
        view.cancelAnimationFrame(frame);
        frame = 0;
        if (!manual) beginManual();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1;
        moveBy(-horizontal * unit);
        const lastWheel = view.performance.now();
        function settle(time) {
            if (disposed) return;
            if (time - lastWheel < 200) frame = view.requestAnimationFrame(settle);
            else { frame = 0; resume(); }
        }
        frame = view.requestAnimationFrame(settle);
    }
    function resized() {
        if (!manual) return;
        const progress = position / step;
        measure(); position = progress * step; paint();
    }
    function focus(event) {
        if (!event.target.matches('a:focus-visible')) return;
        gesture = null;
        delete viewport.dataset.dragging;
        stopMomentum();
    }
    viewport.addEventListener('pointerdown', down);
    viewport.addEventListener('pointermove', move, { passive: false });
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    viewport.addEventListener('click', click, true);
    viewport.addEventListener('dragstart', preventNativeDrag);
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('focusin', focus);
    view.addEventListener('resize', resized);
    return () => {
        disposed = true;
        stopMomentum();
        delete viewport.dataset.dragging;
        viewport.removeEventListener('pointerdown', down);
        viewport.removeEventListener('pointermove', move);
        view.removeEventListener('pointerup', up);
        view.removeEventListener('pointercancel', up);
        viewport.removeEventListener('click', click, true);
        viewport.removeEventListener('dragstart', preventNativeDrag);
        viewport.removeEventListener('wheel', wheel);
        viewport.removeEventListener('focusin', focus);
        view.removeEventListener('resize', resized);
    };
}
