import test from 'node:test';
import assert from 'node:assert/strict';
import { startPrivateRefresh } from '../src/lib/privateRefresh.js';

function fixture({ hidden = false, refresh = async () => true } = {}) {
    let clock = 0, sequence = 0, calls = 0;
    const jobs = new Map(), document = new EventTarget(), window = new EventTarget(); document.hidden = hidden;
    const timers = { setTimeout(fn, ms) { jobs.set(++sequence, { fn, at: clock + ms }); return sequence; }, clearTimeout(id) { jobs.delete(id); } };
    const stop = startPrivateRefresh({ refresh: async () => { calls++; return refresh(); }, document, window, timers, now: () => clock, random: () => 0 });
    return { jobs, document, window, stop, calls: () => calls,
        async tick() { const [id, job] = [...jobs].sort((a,b) => a[1].at-b[1].at)[0]; jobs.delete(id); clock = job.at; await job.fn(); },
        advance(ms) { clock += ms; }, time: () => clock };
}
test('private reads pause hidden, wake on focus, and use a one-minute visible cadence', async () => {
    const f = fixture(); await f.tick(); assert.equal(f.calls(), 1);
    assert.equal([...f.jobs.values()][0].at, 60000);
    f.document.hidden = true; f.document.dispatchEvent(new Event('visibilitychange')); assert.equal(f.jobs.size, 0);
    f.advance(70000); f.window.dispatchEvent(new Event('focus')); assert.equal(f.jobs.size, 0);
    f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange')); f.window.dispatchEvent(new Event('focus'));
    assert.equal(f.jobs.size, 1); await f.tick(); assert.equal(f.calls(), 2); f.stop();
});
test('an initially hidden tab waits until visible', async () => {
    const f = fixture({ hidden: true }); assert.equal(f.jobs.size, 0); assert.equal(f.calls(), 0);
    f.document.hidden = false; f.document.dispatchEvent(new Event('visibilitychange')); await f.tick();
    assert.equal(f.calls(), 1); f.stop();
});
test('focus/visibility events cannot overlap a pending read or cause a focus storm', async () => {
    let finish;
    const f = fixture({ refresh: () => new Promise(resolve => { finish = resolve; }) });
    const reading = f.tick();
    for (let i = 0; i < 10; i++) { f.window.dispatchEvent(new Event('focus')); f.document.dispatchEvent(new Event('visibilitychange')); }
    assert.equal(f.calls(), 1); assert.equal(f.jobs.size, 0);
    finish(true); await reading; f.window.dispatchEvent(new Event('focus'));
    assert.equal([...f.jobs.values()][0].at, 5000); f.stop(); assert.equal(f.jobs.size, 0);
});
test('failure backoff survives focus changes; success resets the cadence', async () => {
    let success = false;
    const f = fixture({ refresh: async () => success });
    await f.tick(); f.window.dispatchEvent(new Event('focus')); assert.equal([...f.jobs.values()][0].at-f.time(), 60000);
    await f.tick(); f.document.dispatchEvent(new Event('visibilitychange')); assert.equal([...f.jobs.values()][0].at-f.time(), 120000);
    await f.tick(); assert.equal([...f.jobs.values()][0].at-f.time(), 240000);
    await f.tick(); assert.equal([...f.jobs.values()][0].at-f.time(), 300000);
    success = true; await f.tick(); assert.equal([...f.jobs.values()][0].at-f.time(), 60000); f.stop();
});
test('cleanup prevents a late private read from scheduling more work', async () => {
    let finish;
    const f = fixture({ refresh: () => new Promise(resolve => { finish = resolve; }) });
    const reading = f.tick(); f.stop(); finish(true); await reading;
    f.window.dispatchEvent(new Event('focus')); f.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(f.jobs.size, 0); assert.equal(f.calls(), 1);
});
