import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeItemName } from '../scripts/lib/item-name.mjs';
import { parseItemCatalog } from '../scripts/lib/item-catalog.mjs';
test('quotation entities decode as plain text without interpreting markup or double decoding', () => {
    assert.equal(decodeItemName('colored-light &quot;necklace&quot;'), 'colored-light "necklace"');
    assert.equal(decodeItemName('&#34;A&#x22; &apos;B&#39;'), '"A" \'B\'');
    assert.equal(decodeItemName('<img src=x> &amp;quot;'), '<img src=x> &amp;quot;');
    assert.equal(decodeItemName(undefined), undefined);
    const rows=parseItemCatalog('1\n# item number\tname\tdescid\timage\tuse\taccess\tautosell\tplural\n1\t&quot;quoted&quot;\t123\ttest.gif\tnone\tt\t0', {minimum:1,minimumTradeable:1});
    assert.equal(rows[0].name,'"quoted"');
});
