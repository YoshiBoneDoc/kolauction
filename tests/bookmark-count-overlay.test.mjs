import test from 'node:test';
import assert from 'node:assert/strict';
import { createBookmarkCountOverlay } from '../src/lib/bookmarkCountOverlay.js';
const snapshot = (count, earliest = 0, latest = 10) => ({ counts: { auction: count }, earliest, latest });
test('successful toggles adjust only the current user; no-ops and duplicate notices do not add counts', () => {
    const overlay = createBookmarkCountOverlay();
    const cached = snapshot(3);
    assert.equal(overlay.counts('user', cached).auction, 3);
    overlay.changed('user', 'auction', false, true, 20, 30);
    assert.equal(overlay.counts('user', cached).auction, 4);
    assert.equal(overlay.counts('other', cached).auction, 3);
    assert.equal(overlay.counts(null, cached).auction, 3);
    overlay.changed('user', 'auction', true, true, 40, 50);
    overlay.changed('user', 'auction', false, true, 40, 50);
    assert.equal(overlay.counts('user', cached).auction, 4);
    overlay.changed('user', 'auction', true, false, 60, 70);
    assert.equal(overlay.counts('user', cached).auction, 3);
});
test('fresh snapshots absorb changes once, including old snapshots reached through back navigation', () => {
    const overlay = createBookmarkCountOverlay();
    overlay.changed('user', 'auction', false, true, 20, 30);
    assert.equal(overlay.counts('user', snapshot(3)).auction, 4);
    assert.equal(overlay.counts('user', snapshot(4, 40, 50)).auction, 4);
    assert.equal(overlay.counts('user', snapshot(3)).auction, 4);
    overlay.changed('user', 'auction', true, false, 60, 70);
    assert.equal(overlay.counts('user', snapshot(4, 40, 50)).auction, 3);
    assert.equal(overlay.counts('user', snapshot(3, 80, 90)).auction, 3);
});
test('reads overlapping writes hold the locally adjusted display until an unambiguous read', () => {
    const overlay = createBookmarkCountOverlay();
    overlay.counts('user', snapshot(3));
    let updates = 0;
    const unsubscribe = overlay.subscribe(() => updates++);
    overlay.changed('user', 'auction', false, true, 20, 30);
    assert.equal(updates, 1);
    assert.equal(overlay.counts('user', snapshot(4, 15, 35)).auction, 4);
    assert.equal(overlay.counts('user', snapshot(3, 15, 35)).auction, 4);
    assert.equal(overlay.counts('user', snapshot(5, 40, 50)).auction, 5);
    unsubscribe();
    overlay.changed('user', 'auction', true, false, 60, 70);
    assert.equal(updates, 1);
});

test('ribbon saved state is immediate, user-scoped and independent of shared counts', () => {
    const overlay = createBookmarkCountOverlay();
    assert.equal(overlay.savedIds('user', ['existing']).has('existing'), true);
    overlay.changed('user', 'auction', false, true, 20, 30);
    assert.equal(overlay.savedIds('user', []).has('auction'), true);
    assert.equal(overlay.savedIds('other', []).has('auction'), false);
    overlay.changed('user', 'auction', true, false, 40, 50);
    assert.equal(overlay.savedIds('user', ['auction']).has('auction'), false);
});

test('host bookmarks retain private saved state without changing public counts', () => {
    const overlay = createBookmarkCountOverlay();
    overlay.counts('host', snapshot(3));
    overlay.changed('host', 'auction', false, true, 20, 30, false);
    assert.equal(overlay.counts('host', snapshot(3)).auction, 3);
    assert.equal(overlay.savedIds('host', []).has('auction'), true);
    overlay.changed('host', 'auction', true, false, 40, 50, false);
    assert.equal(overlay.counts('host', snapshot(3)).auction, 3);
    assert.equal(overlay.savedIds('host', ['auction']).has('auction'), false);
});
