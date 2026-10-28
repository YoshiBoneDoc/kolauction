import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleProfileSection } from '../src/lib/profileSections.js';

test('profile section collapse state toggles independently and preserves other sections', () => {
    let collapsed = {};
    collapsed = toggleProfileSection(collapsed, 'Active bids');
    assert.deepEqual(collapsed, { 'Active bids': true });
    collapsed = toggleProfileSection(collapsed, 'Bid history');
    assert.deepEqual(collapsed, { 'Active bids': true, 'Bid history': true });
    collapsed = toggleProfileSection(collapsed, 'Active bids');
    assert.deepEqual(collapsed, { 'Active bids': false, 'Bid history': true });
});
