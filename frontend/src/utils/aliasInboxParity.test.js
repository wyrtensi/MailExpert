import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { recipientAliasFor } from './mailboxBanner.js';

// The same fixture the backend suite reads (message_reply_alias): the list pill and the server's
// alias Inbox must agree on every case.
const fixture = JSON.parse(readFileSync(
  new URL('../../../backend/src/services/aliasMailbox.fixtures.json', import.meta.url), 'utf8'));

const accountOf = (key) => ({
  id: key,
  ...fixture.accounts[key],
  aliases: fixture.aliases.filter((a) => a.account === key),
});
const foldersOf = (key) => fixture.folders.filter((f) => f.account === key);

describe('recipientAliasFor parity with the server alias rule', () => {
  for (const c of fixture.cases.filter((x) => x.folder === 'INBOX')) {
    it(`fixture: ${c.name}`, () => {
      const message = {
        folder: c.folder,
        from_email: c.from_email,
        to_addresses: c.to.map((email) => ({ name: '', email })),
        cc_addresses: c.cc.map((email) => ({ name: '', email })),
        delivery_addresses: c.delivery,
      };
      const pill = recipientAliasFor(message, accountOf(c.account), foldersOf(c.account));
      assert.equal(pill?.active ? pill.address.toLowerCase() : null, c.inbox);
    });
  }
});
