// Proton's native IMAP (Bridge) keeps user folders under "Folders/" and labels under "Labels/";
// creating a mailbox at the root is refused (HTTP 500 in the spike). The account-aware ensureFolder
// and renameFolder of the mail engine translate for a managed Proton mailbox only; ensureMailbox
// and every other provider keep their behavior.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

vi.mock('imapflow', () => ({ ImapFlow: vi.fn() }));
vi.mock('../db.js', () => ({ query: vi.fn() }));
vi.mock('../messageParser.js', () => ({ parseMessage: vi.fn(), buildSnippetFromHtml: vi.fn(), snippetFromBody: vi.fn(), decodeMimeWords: vi.fn(), detectBulkFromParsedHeaders: vi.fn(), parseRawHeaders: vi.fn(), enrichParsedMetadata: vi.fn((p) => p), headersToRawString: vi.fn(() => 'Subject: hello') }));
vi.mock('../../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
vi.mock('../emailSanitizer.js', () => ({ sanitizeEmail: vi.fn() }));
vi.mock('../encryption.js', () => ({ decrypt: vi.fn(() => 'pw') }));
vi.mock('../aiProvider.js', () => ({ getAiStatus: vi.fn(), completeText: vi.fn() }));
vi.mock('../pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
vi.mock('../../utils/redact.js', () => ({ redactEmail: vi.fn(() => 'a***@example.com') }));
vi.mock('../hostValidation.js', () => ({ resolveForConnection: vi.fn(), createPinnedLookup: vi.fn() }));
vi.mock('../connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));
vi.mock('../spamPipeline.js', () => ({ classifyAndTagMessage: vi.fn() }));
vi.mock('../mailAccess.js', () => ({ getAccountAddresses: vi.fn(async () => []) }));
vi.mock('./mailEndpoint.js', async (original) => ({ ...(await original()), resolveProtonEndpoint: vi.fn() }));

const { ImapManager, evictPool, ensureMailbox } = await import('../imapManager.js');
const { ImapFlow } = await import('imapflow');
const { query } = await import('../db.js');
const { resolveForConnection } = await import('../hostValidation.js');
const { getConnectionPolicy } = await import('../connectionPolicy.js');
const { resolveProtonEndpoint, MANAGED_PROTON_ENDPOINT } = await import('./mailEndpoint.js');
const { normalizeProtonFolderPath, ProtonFolderError } = await import('./folders.js');

const proton = {
  id: 'proton-folders', imap_host: '127.0.0.1', imap_port: 1993, auth_user: 'box@proton.me', auth_pass: 'enc',
  enabled: true, mail_provider: 'proton', connection_mode: 'managed', imap_tls_mode: 'implicit',
};
const plain = {
  id: 'plain-folders', imap_host: 'imap.example.com', imap_port: 993, imap_tls: true, auth_user: 'u', auth_pass: 'enc', enabled: true,
};
// The provider column alone (a preset or hand-made Proton row) does not make a managed mailbox.
const presetProton = { ...plain, id: 'preset-proton', mail_provider: 'proton', connection_mode: 'preset' };

let server;
function connection() {
  return Object.assign(new EventEmitter(), {
    capabilities: new Map([['IMAP4rev1', true], ['UIDPLUS', true]]),
    enabled: new Set(),
    namespace: { delimiter: '/', prefix: '' },
    states: { NOT_AUTHENTICATED: 1, AUTHENTICATED: 2, SELECTED: 3, LOGOUT: 4 },
    state: 2,
    mailbox: false,
    log: { warn: () => {}, debug: () => {}, info: () => {}, error: () => {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(),
    logout: vi.fn(async () => {}),
    noop: vi.fn(async () => true),
    run: vi.fn(async () => true),
    async mailboxCreate(segments) {
      const path = segments.join('/');
      server.creates.push(path);
      if (server.refuseRoot && segments.length === 1) throw Object.assign(new Error('Command failed'), { responseText: 'cannot create' });
      return { path, created: true };
    },
    async mailboxRename(from, to) {
      server.renames.push([from, to]);
      return { path: from, newPath: to };
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  for (const account of [proton, plain, presetProton]) evictPool(account.id);
  server = { creates: [], renames: [], refuseRoot: true };
  getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false, allowInsecureTls: false });
  resolveForConnection.mockResolvedValue({ host: '203.0.113.10', addresses: ['203.0.113.10'], servername: 'imap.example.com' });
  resolveProtonEndpoint.mockResolvedValue({
    host: '127.0.0.1', port: 1993, addresses: ['127.0.0.1'], servername: null,
    tls: { rejectUnauthorized: true, ca: 'public-pem' }, secure: true, requireTLS: false, imapTlsMode: 'implicit',
    [MANAGED_PROTON_ENDPOINT]: true,
  });
  query.mockResolvedValue({ rows: [] });
  ImapFlow.mockImplementation(function () { return connection(); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const account of [proton, plain, presetProton]) evictPool(account.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const manager = () => {
  const mgr = new ImapManager(null);
  vi.clearAllTimers(); // the constructor's schedulers are not under test
  return mgr;
};
const refusal = (fn) => {
  try { fn(); } catch (err) { return err; }
  return null;
};

describe('normalizeProtonFolderPath', () => {
  it('root_folder_gets_folders_namespace', async () => {
    expect(normalizeProtonFolderPath('Work')).toBe('Folders/Work');
    expect(normalizeProtonFolderPath('Work/2026')).toBe('Folders/Work/2026');
    expect(normalizeProtonFolderPath('2026', { parent: 'Work' })).toBe('Folders/Work/2026');
    expect(normalizeProtonFolderPath('Snoozed')).toBe('Folders/Snoozed');

    const created = await manager().ensureFolder(proton, 'Work', { resolvePath: true });
    expect(created).toEqual({ path: 'Folders/Work', created: true });
    expect(server.creates).toEqual(['Folders/Work']);
  });

  it('already_prefixed_folder_not_double_prefixed', async () => {
    expect(normalizeProtonFolderPath('Folders/Work')).toBe('Folders/Work');
    expect(normalizeProtonFolderPath('Folders/Work/2026')).toBe('Folders/Work/2026');
    expect(normalizeProtonFolderPath('2026', { parent: 'Folders/Work' })).toBe('Folders/Work/2026');
    expect(normalizeProtonFolderPath(normalizeProtonFolderPath('Work'))).toBe('Folders/Work');

    await manager().ensureFolder(proton, 'Folders/Work');
    expect(server.creates).toEqual(['Folders/Work']);
  });

  it('labels_are_not_creatable_as_folders', async () => {
    for (const [path, parent] of [['Labels/Work'], ['labels/Work'], ['Work', 'Labels'], ['Labels'], ['Folders'], ['a//b'], [''], ['  ']]) {
      const err = refusal(() => normalizeProtonFolderPath(path, { parent }));
      expect(err).toBeInstanceOf(ProtonFolderError);
      expect(err.code).toBe(path.toLowerCase().startsWith('labels') || parent === 'Labels' ? 'proton_label_not_folder' : 'proton_folder_invalid');
    }

    await expect(manager().ensureFolder(proton, 'Labels/Work')).rejects.toMatchObject({ code: 'proton_label_not_folder' });
    // Refused before any session is opened.
    expect(ImapFlow).not.toHaveBeenCalled();
    expect(server.creates).toEqual([]);
  });

  it('drafts_sent_and_flags_keep_existing_behavior', async () => {
    for (const special of ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'All Mail', 'Starred']) {
      expect(normalizeProtonFolderPath(special)).toBe(special);
    }
    // A system folder has no children on Proton: nothing is created under it.
    expect(refusal(() => normalizeProtonFolderPath('Sent/2026'))?.code).toBe('proton_folder_invalid');

    server.refuseRoot = false;
    const mgr = manager();
    // Other providers and a provider label without the managed mode: untouched paths.
    await mgr.ensureFolder(plain, 'Work');
    await mgr.ensureFolder(presetProton, 'Labels/Work');
    expect(server.creates).toEqual(['Work', 'Labels/Work']);
    // ensureMailbox itself (the shared primitive) never translates.
    const client = connection();
    await ensureMailbox(client, 'Work');
    expect(server.creates.at(-1)).toBe('Work');

    // Only the account-aware ensureFolder and renameFolder know the namespace; Sent appends,
    // drafts and flag stores go through the shared code unchanged.
    const source = readFileSync(new URL('../imapManager.js', import.meta.url), 'utf8');
    expect(source.match(/accountFolderPath\(|accountRenameTarget\(/g)).toHaveLength(2);
    const ensureMailboxBody = source.slice(source.indexOf('export async function ensureMailbox'), source.indexOf('async function resolveServerFolderCasing'));
    expect(ensureMailboxBody).not.toMatch(/proton|Folders\//i);
  });
});

describe('renameFolder on a managed Proton mailbox', () => {
  it('keeps a renamed folder inside the Folders namespace', async () => {
    const mgr = manager();
    await mgr.renameFolder(proton, 'Folders/Work', 'Folders/Projects');
    await mgr.renameFolder(proton, 'Labels/Old', 'Labels/New');
    expect(server.renames).toEqual([['Folders/Work', 'Folders/Projects'], ['Labels/Old', 'Labels/New']]);
  });

  it('refuses to rename the namespace roots or a folder out of them', async () => {
    const mgr = manager();
    await expect(mgr.renameFolder(proton, 'Folders', 'Mine')).rejects.toMatchObject({ code: 'proton_folder_invalid' });
    await expect(mgr.renameFolder(proton, 'Labels', 'Mine')).rejects.toMatchObject({ code: 'proton_folder_invalid' });
    await expect(mgr.renameFolder(proton, 'Labels/Old', 'Folders/New')).rejects.toMatchObject({ code: 'proton_label_not_folder' });
    await expect(mgr.renameFolder(proton, 'Sent', 'Outgoing')).rejects.toMatchObject({ code: 'proton_folder_invalid' });
    expect(server.renames).toEqual([]);
    expect(ImapFlow).not.toHaveBeenCalled();
  });

  it('leaves other providers on the shared rename', async () => {
    await manager().renameFolder(plain, 'Projects', 'Projects 2024');
    expect(server.renames).toEqual([['Projects', 'Projects 2024']]);
  });
});
