// DB-first moves. A user's move, archive, delete to Trash or spam/not-spam changes the panel's
// database at once and answers the request; the MOVE on the mail server runs later, from a
// durable queue (migration 0075, table message_moves), in the background. The panel database is
// the source of truth for the people using it, so a busy mailbox no longer turns a move into a
// "mailbox busy, try again" error. Flag changes work the same way (the flag-push queue).
//
// Life of a moved row (UIDPLUS server, the normal case):
//   1. The route enqueues: one message_moves row (id n) holding where the letter is on the server
//      (src_folder, src_uid) and where it goes (dest_folder). In the same statement the message
//      row moves to dest_folder with the placeholder uid -n. The row keeps its id, so the client
//      and every later action address the same row. Placeholders are negative, so they never
//      collide with a server UID in UNIQUE(account_id, uid, folder).
//   2. While the move is pending, (account, src_folder, src_uid) and (account, dest_folder, -n)
//      are guarded (ImapManager._guardMoveUid): reconcileDeletes and the integrity pass do not
//      delete either, and sync and backfill do not insert the letter at the source again.
//   3. The worker claims the account's queued moves, groups them by (source, destination) and
//      sends one MOVE per group, after any flag store already called on those letters
//      (ImapManager.flagStoresSettled). The server names the new uid U (COPYUID), and the row
//      takes it (settle). A destination sync that sees the letter first attaches it to the row
//      instead of inserting a second one (claimArrival), and the settle then has nothing to do.
//   4. A read or star change made while the move is pending is stored on the queue row
//      (deferFlags) and written at (dest_folder, U) after the MOVE.
// A server that names no new uid leaves the move awaiting_uid: the destination sync attaches the
// letter by its Message-ID, or the worker looks it up. A letter moved again while its move is in
// flight gets a second move whose source uid is filled in when the first one settles.
//
// Failures: one that may pass (the server did not move a letter it still has, a dropped
// connection) is retried with backoff; a busy pool or a login held back by the account's
// backoffs (#98, #99, #102) is not counted as an attempt. A permanent one (the letter is gone
// from the source, the destination folder is gone) or MOVE_MAX_ATTEMPTS failures return the row
// to its source folder and uid and tell every client (move_reverted).
import { query, withTransaction } from './db.js';
import { adjustFolderCounts } from '../utils/mailUtils.js';
import { isMailboxBusyError } from './imapManager.js';

export const MOVE_MAX_ATTEMPTS = 8;
export const MOVE_RETRY_BASE_MS = 15 * 1000;
export const MOVE_RETRY_MAX_MS = 10 * 60 * 1000;
export const MOVE_QUEUE_TICK_MS = 5 * 1000;
export const MOVE_CLAIM_LIMIT = 500;
// A FETCH that started before the MOVE and is processed after it would insert the letter at its
// source again, so the source guard outlives a settled move by this much.
export const MOVE_SOURCE_GUARD_LINGER_MS = 10 * 1000;
// How often a move awaiting its new uid is looked up again, and for how long.
export const MOVE_AWAITING_RETRY_MS = 15 * 1000;
export const MOVE_AWAITING_UID_MAX_MS = 10 * 60 * 1000;

export function moveRetryDelayMs(attempts) {
  return Math.min(MOVE_RETRY_MAX_MS, MOVE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export const placeholderUid = (moveId) => -Number(moveId);
export const isPendingUid = (uid) => Number(uid) < 0;

const FLAG_COLUMNS = { '\\Seen': 'set_seen', '\\Flagged': 'set_flagged' };

export class MoveQueue {
  constructor(mgr) {
    this.mgr = mgr;
    this._guards = new Map();   // moveId -> { accountId, list: [{ folder, uid }] }
    this._arrivals = new Map(); // `${accountId}\n${folder}` -> Map<message id header, Set<moveId>>
    this._running = new Set();  // accountId with a worker run in progress
    this._again = new Set();    // accountId kicked while its run was in progress
    this._timer = null;
  }

  // ── Guards and expected arrivals (in memory, rebuilt from the table by resume) ──────────

  _guard(op) {
    this._unguard(op.id);
    const list = [{ folder: op.dest_folder, uid: placeholderUid(op.id) }];
    if (op.src_uid != null) list.push({ folder: op.src_folder, uid: Number(op.src_uid) });
    for (const g of list) this.mgr._guardMoveUid(op.account_id, g.folder, g.uid);
    this._guards.set(String(op.id), { accountId: op.account_id, list });
  }

  // lingerSource: the letter left the source; keep that guard a little longer (see above).
  _unguard(moveId, { lingerSource = false } = {}) {
    const entry = this._guards.get(String(moveId));
    if (!entry) return;
    this._guards.delete(String(moveId));
    for (const g of entry.list) {
      const release = () => this.mgr._unguardMoveUid(entry.accountId, g.folder, g.uid);
      if (lingerSource && g.uid > 0) {
        const timer = setTimeout(release, MOVE_SOURCE_GUARD_LINGER_MS);
        timer.unref?.();
      } else {
        release();
      }
    }
  }

  // Only a move whose MOVE is on its way or done expects its letter in the destination. Before
  // that, a letter with the same Message-ID arriving there is a separate copy and is inserted.
  _expect(op) {
    if (!op.message_id_header) return;
    const key = `${op.account_id}\n${op.dest_folder}`;
    if (!this._arrivals.has(key)) this._arrivals.set(key, new Map());
    const byMid = this._arrivals.get(key);
    if (!byMid.has(op.message_id_header)) byMid.set(op.message_id_header, new Set());
    byMid.get(op.message_id_header).add(String(op.id));
  }

  _unexpect(op) {
    if (!op.message_id_header) return;
    const key = `${op.account_id}\n${op.dest_folder}`;
    const byMid = this._arrivals.get(key);
    const ids = byMid?.get(op.message_id_header);
    if (!ids) return;
    ids.delete(String(op.id));
    if (!ids.size) byMid.delete(op.message_id_header);
    if (!byMid.size) this._arrivals.delete(key);
  }

  expectsArrival(accountId, folder, messageId) {
    if (!messageId) return false;
    return !!this._arrivals.get(`${accountId}\n${folder}`)?.get(messageId)?.size;
  }

  // Sync and backfill call this before inserting a letter they found at (folder, uid). When a
  // move in flight expects that letter there, the moved row takes the uid (or the move that
  // follows it takes it as its source) and true is returned: the caller inserts nothing, so the
  // letter neither shows twice nor counts as new mail (no notification, no inbox rules on a
  // letter the user just moved to INBOX).
  async claimArrival(accountId, folder, messageId, uid) {
    if (!this.expectsArrival(accountId, folder, messageId)) return false;
    const { rows: [op] } = await query(
      `SELECT * FROM message_moves
        WHERE account_id = $1 AND dest_folder = $2 AND message_id_header = $3 AND state IN ('moving', 'awaiting_uid')
        ORDER BY id LIMIT 1`,
      [accountId, folder, messageId]
    );
    if (!op) return false;
    const settled = await this._settle(op, Number(uid));
    // No row took the letter (its row is gone): the caller inserts it as it would any letter.
    if (!settled || (!settled.row && !settled.next)) return false;
    if (settled.row) {
      const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
      if (account) {
        this._storeSettledFlags(account, [settled])
          .catch(err => console.warn(`Move queue: flag store after arrival failed: ${err.message}`));
        if (settled.needsProviderIds) this.mgr._scheduleProviderIdBackfill(account);
      }
    }
    return true;
  }

  // ── Routes ───────────────────────────────────────────────────────────────────────────────

  // Move `rows` (message rows of one account, as the route read them) to `dest` in the database
  // and queue the server MOVE. dropRow: the destination is not synced (Gmail All Mail), so the
  // row is deleted once the server has moved the letter. Returns the ids of the rows now in
  // `dest` as far as the panel is concerned (a row already there counts).
  async enqueue(accountId, rows, dest, { dropRow = false } = {}) {
    const moved = new Set(rows.filter(r => r.folder === dest).map(r => r.id));
    const fresh = rows.filter(r => r.folder !== dest && !isPendingUid(r.uid));
    let retry = rows.filter(r => r.folder !== dest && isPendingUid(r.uid)).map(r => r.id);
    const created = [];

    if (fresh.length) {
      const { rows: ops } = await query(
        `WITH src AS (
           SELECT id, account_id, folder, uid, message_id FROM messages
            WHERE id = ANY($1::uuid[]) AND account_id = $2 AND uid > 0 AND folder <> $3
            FOR UPDATE
         ), ins AS (
           INSERT INTO message_moves (account_id, message_row_id, message_id_header, src_folder, src_uid, dest_folder, drop_row)
           SELECT account_id, id, message_id, folder, uid, $3, $4 FROM src
           RETURNING *
         )
         UPDATE messages m SET folder = $3, uid = -ins.id
           FROM ins WHERE m.id = ins.message_row_id
         RETURNING ins.*`,
        [fresh.map(r => r.id), accountId, dest, dropRow]
      );
      for (const op of ops) { created.push(op); moved.add(op.message_row_id); }
      // A row another request moved in the meantime is pending now: take the path below.
      retry = retry.concat(fresh.filter(r => !moved.has(r.id)).map(r => r.id));
    }

    for (const rowId of retry) {
      const outcome = await this._enqueuePending(accountId, rowId, dest, dropRow);
      if (outcome) moved.add(rowId);
      if (outcome?.op) created.push(outcome.op);
    }

    for (const op of created) this._guard(op);
    if (created.length) {
      await this._absorbFlagPushes(accountId, [...moved]);
      this.kick(accountId);
    }
    return [...moved];
  }

  // A row whose move is still pending is moved again. Returns { op } for a move queued or
  // changed, { cancelled } when the letter goes back to where the server has it, null when the
  // row is gone. Each statement locks the message row first, as the worker's settle does, so a
  // settle and this never interleave.
  async _enqueuePending(accountId, rowId, dest, dropRow) {
    // The latest move is still queued and its source is the new destination: drop it, and the row
    // goes back to the letter's server location (or to its predecessor's placeholder).
    const cancelled = await query(
      `WITH m AS (SELECT id, uid FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 FOR UPDATE),
       op AS (
         DELETE FROM message_moves mv USING m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state = 'queued' AND mv.src_folder = $3
         RETURNING mv.*
       )
       UPDATE messages x SET folder = op.src_folder, uid = COALESCE(op.src_uid, -op.predecessor_id)
         FROM op WHERE x.id = op.message_row_id
       RETURNING op.*`,
      [rowId, accountId, dest]
    );
    if (cancelled.rows[0]) {
      this._unguard(cancelled.rows[0].id);
      return { cancelled: cancelled.rows[0] };
    }
    // Still queued: it takes the new destination.
    const changed = await query(
      `WITH m AS (SELECT id, uid FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 AND folder <> $3 FOR UPDATE),
       op AS (
         UPDATE message_moves mv SET dest_folder = $3, drop_row = $4, updated_at = now() FROM m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state = 'queued'
         RETURNING mv.*
       )
       UPDATE messages x SET folder = $3 FROM op WHERE x.id = op.message_row_id
       RETURNING op.*`,
      [rowId, accountId, dest, dropRow]
    );
    if (changed.rows[0]) return { op: changed.rows[0] };
    // In flight: a second move follows it; its source uid comes when the first one settles.
    const next = await query(
      `WITH m AS (SELECT id, uid FROM messages WHERE id = $1 AND account_id = $2 AND uid < 0 AND folder <> $3 FOR UPDATE),
       prev AS (
         SELECT mv.* FROM message_moves mv, m
          WHERE mv.id = -m.uid AND mv.message_row_id = m.id AND mv.state <> 'queued'
       ), ins AS (
         INSERT INTO message_moves (account_id, message_row_id, message_id_header, src_folder, src_uid, dest_folder, drop_row, predecessor_id)
         SELECT account_id, message_row_id, message_id_header, dest_folder, NULL, $3, $4, id FROM prev
         RETURNING *
       )
       UPDATE messages x SET folder = $3, uid = -ins.id FROM ins WHERE x.id = ins.message_row_id
       RETURNING ins.*`,
      [rowId, accountId, dest, dropRow]
    );
    if (next.rows[0]) return { op: next.rows[0] };
    // The move settled in between (the row has a server uid again) or the row is gone.
    const { rows: [row] } = await query('SELECT id, uid, folder FROM messages WHERE id = $1 AND account_id = $2', [rowId, accountId]);
    if (!row) return null;
    if (row.folder === dest) return {};
    if (isPendingUid(row.uid)) return null; // moved by another request at this very moment
    const again = await this.enqueue(accountId, [row], dest, { dropRow });
    return again.includes(rowId) ? {} : null;
  }

  // A read/star push that failed before the move was queued now belongs to the move: stored at the
  // destination after the MOVE, and durable (the flag-push queue lives in memory only).
  async _absorbFlagPushes(accountId, rowIds) {
    const ops = this.mgr._pendingFlagPush?.get(accountId);
    if (!ops?.size) return;
    for (const flag of Object.keys(FLAG_COLUMNS)) {
      for (const value of [true, false]) {
        const ids = rowIds.filter(id => ops.get(`${id}:${flag}`)?.value === value);
        if (!ids.length) continue;
        const { deferred } = await this.deferFlags(ids.map(id => ({ id, uid: -1 })), flag, value);
        for (const id of deferred) this.mgr._resolveFlagPush(accountId, id, flag);
      }
    }
  }

  // A read or star change on rows whose move has not reached the server: there is no server uid
  // to store at yet, so the value goes onto the move and is stored at the destination after it.
  // Returns { deferred: Set<id>, located: Map<id, { uid, folder }> }: located holds the rows whose
  // move settled in the meantime, with their server location to store at now.
  async deferFlags(rows, flag, value) {
    const pending = rows.filter(r => isPendingUid(r.uid)).map(r => r.id);
    const deferred = new Set();
    const located = new Map();
    if (!pending.length) return { deferred, located };
    const col = FLAG_COLUMNS[flag];
    if (!col) throw new Error(`deferFlags: unknown flag ${flag}`);
    // col is one of two fixed literals above, never input.
    const { rows: done } = await query(
      `UPDATE message_moves mv SET ${col} = $2, updated_at = now()
         FROM messages m
        WHERE m.id = ANY($1::uuid[]) AND mv.id = -m.uid AND mv.message_row_id = m.id
        RETURNING m.id`,
      [pending, value]
    );
    for (const r of done) deferred.add(r.id);
    const rest = pending.filter(id => !deferred.has(id));
    if (rest.length) {
      const { rows: fresh } = await query('SELECT id, uid, folder FROM messages WHERE id = ANY($1::uuid[])', [rest]);
      for (const r of fresh) if (!isPendingUid(r.uid)) located.set(r.id, { uid: Number(r.uid), folder: r.folder });
    }
    return { deferred, located };
  }

  // Where the letter of `row` is on the server right now, for a route that reads it (body,
  // headers, attachments): its own folder and uid, or the source of its queued move. null while
  // the MOVE is in flight: the letter is between folders for a moment.
  async serverLocation(row) {
    if (!isPendingUid(row.uid)) return { folder: row.folder, uid: Number(row.uid) };
    const { rows: [op] } = await query(
      'SELECT state, src_folder, src_uid FROM message_moves WHERE id = $1 AND message_row_id = $2',
      [-Number(row.uid), row.id]
    );
    if (op && op.state === 'queued' && op.src_uid != null) return { folder: op.src_folder, uid: Number(op.src_uid) };
    const { rows: [fresh] } = await query('SELECT uid, folder FROM messages WHERE id = $1', [row.id]);
    if (fresh && !isPendingUid(fresh.uid)) return { folder: fresh.folder, uid: Number(fresh.uid) };
    return null;
  }

  // ── Worker ───────────────────────────────────────────────────────────────────────────────

  // Startup: moves that were in flight when the process stopped may or may not have reached the
  // server, so they are looked up like a move whose new uid is unknown (awaiting_uid): found in
  // the destination, the row takes it; still at the source, the move is queued again. Guards and
  // expected arrivals are rebuilt before any sync runs (index.js calls this right after the
  // migrations, before the mailboxes connect).
  async resume() {
    await query(`UPDATE message_moves SET state = 'awaiting_uid', next_attempt_at = now(), updated_at = now() WHERE state = 'moving'`);
    const { rows } = await query('SELECT * FROM message_moves ORDER BY id');
    for (const op of rows) {
      this._guard(op);
      if (op.state === 'awaiting_uid') this._expect(op);
    }
    this.start();
    for (const accountId of new Set(rows.map(r => r.account_id))) this.kick(accountId);
    return rows.length;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch(err => console.error('Move queue tick failed:', err.message));
    }, MOVE_QUEUE_TICK_MS);
    this._timer.unref?.();
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    const { rows } = await query(
      `SELECT DISTINCT account_id FROM message_moves
        WHERE next_attempt_at <= now()
          AND ((state = 'queued' AND src_uid IS NOT NULL) OR state = 'awaiting_uid')`
    );
    for (const { account_id: accountId } of rows) this.kick(accountId);
  }

  kick(accountId) {
    this.runAccount(accountId).catch(err => console.error(`Move queue run failed for account ${accountId}:`, err.message));
  }

  // One run at a time per mailbox; a kick during a run makes it go once more.
  async runAccount(accountId) {
    if (this._running.has(accountId)) { this._again.add(accountId); return; }
    this._running.add(accountId);
    try {
      do {
        this._again.delete(accountId);
        await this._runAccountOnce(accountId);
      } while (this._again.has(accountId));
    } finally {
      this._running.delete(accountId);
    }
  }

  // The same gates as the flag-push reconciler: only while the mailbox is connected (a live
  // persistent session, or poll-only by design), and never while its backoffs hold background
  // logins back (a rejected password must not become one more login toward fail2ban). A move
  // that waits here is not counted as an attempt.
  _gateOpen(accountId) {
    const mgr = this.mgr;
    if (!mgr.connections.has(accountId) && !mgr._pollOnlyAccounts.has(accountId)) return false;
    return !mgr._secondaryLoginBlocked(accountId);
  }

  _poolOpts(accountId) {
    return { background: true, ...this.mgr._poolLoginOpts(accountId) };
  }

  async _runAccountOnce(accountId) {
    if (!this._gateOpen(accountId)) return;
    const { rows: [account] } = await query('SELECT * FROM email_accounts WHERE id = $1', [accountId]);
    if (!account) return;
    const reverted = [];
    try {
      if (await this._resolveAwaiting(account)) return;
      const { rows: claimed } = await query(
        `UPDATE message_moves SET state = 'moving', updated_at = now()
          WHERE id IN (
            SELECT id FROM message_moves
             WHERE account_id = $1 AND state = 'queued' AND src_uid IS NOT NULL AND next_attempt_at <= now()
             ORDER BY id LIMIT $2
             FOR UPDATE SKIP LOCKED)
            AND state = 'queued'
         RETURNING *`,
        [accountId, MOVE_CLAIM_LIMIT]
      );
      if (!claimed.length) return;
      claimed.sort((a, b) => Number(a.id) - Number(b.id));
      for (const op of claimed) this._expect(op);
      const groups = new Map();
      for (const op of claimed) {
        const key = `${op.src_folder}\n${op.dest_folder}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(op);
      }
      let stopped = false;
      for (const ops of groups.values()) {
        if (stopped || !this._gateOpen(accountId)) { await this._release(ops); stopped = true; continue; }
        stopped = await this._runGroup(account, ops, reverted);
      }
    } finally {
      this._notifyReverted(accountId, reverted);
    }
  }

  // One MOVE for a (source, destination) group. Returns true when the mailbox gave no session
  // (busy pool, login held back): its other groups wait for the next run.
  async _runGroup(account, ops, reverted) {
    const mgr = this.mgr;
    const src = ops[0].src_folder;
    const dest = ops[0].dest_folder;
    const uids = ops.map(o => Number(o.src_uid));
    const byUid = new Map(ops.map(o => [Number(o.src_uid), o]));
    // Flag stores already called on these letters reach the server first, at their source uid.
    await mgr.flagStoresSettled(account.id, src, uids);

    let outcome;
    try {
      outcome = await mgr.bulkMoveMessages(account, uids, src, dest, this._poolOpts(account.id));
    } catch (err) {
      if (isMailboxBusyError(err)) { await this._release(ops); return true; }
      for (const op of ops) await this._retryLater(op, err.message, reverted);
      return false;
    }

    const settled = [];
    let awaiting = false;
    for (const uid of outcome.succeeded) {
      const op = byUid.get(Number(uid));
      if (!op) continue;
      const newUid = outcome.uidMap?.get(Number(uid));
      if (newUid) {
        const s = await this._settle(op, Number(newUid));
        if (s?.row) settled.push(s);
      } else {
        await this._markAwaiting(op);
        awaiting = true;
      }
    }

    if (outcome.failed.length) {
      // The server did not move these. Still at the source: it may pass, retry. Gone from the
      // source (deleted elsewhere, Gmail's web UI included): permanent.
      let present = null;
      try {
        present = new Set((await mgr.searchUids(account, src, outcome.failed.map(Number), this._poolOpts(account.id))).map(Number));
      } catch (err) {
        if (isMailboxBusyError(err)) {
          await this._release(outcome.failed.map(u => byUid.get(Number(u))).filter(Boolean));
          return true;
        }
        console.warn(`Move queue: source check ${src} failed: ${err.message}`);
      }
      const { rows: destRows } = await query('SELECT 1 FROM folders WHERE account_id = $1 AND path = $2', [account.id, dest]);
      for (const uid of outcome.failed) {
        const op = byUid.get(Number(uid));
        if (!op) continue;
        if (present === null) await this._retryLater(op, 'source check failed', reverted);
        else if (!present.has(Number(uid))) await this._revertInto(reverted, op, 'gone');
        else if (!destRows.length) await this._revertInto(reverted, op, 'destination_gone');
        else await this._retryLater(op, 'the server did not move the letter', reverted);
      }
    }

    await this._storeSettledFlags(account, settled);
    if (settled.some(s => s.needsProviderIds)) mgr._scheduleProviderIdBackfill(account);
    if (awaiting) {
      mgr.syncFolderOnDemand(account, dest)
        .catch(err => console.warn(`Move queue: destination sync of ${dest} failed: ${err.message}`));
    }
    return false;
  }

  // Moves whose MOVE went through but whose new uid is unknown (no COPYUID, or a restart cut the
  // answer off). Returns true when the mailbox gave no session.
  async _resolveAwaiting(account) {
    const mgr = this.mgr;
    const { rows } = await query(
      `SELECT * FROM message_moves
        WHERE account_id = $1 AND state = 'awaiting_uid' AND next_attempt_at <= now()
        ORDER BY id LIMIT $2`,
      [account.id, MOVE_CLAIM_LIMIT]
    );
    const settled = [];
    try {
      for (const op of rows) {
        this._expect(op);
        let uid = null;
        let present = null;
        try {
          if (op.message_id_header) {
            uid = await mgr.findUidByMessageId(account, op.dest_folder, op.message_id_header, this._poolOpts(account.id));
          }
          if (!uid) present = await mgr.searchUids(account, op.src_folder, [Number(op.src_uid)], this._poolOpts(account.id));
        } catch (err) {
          if (isMailboxBusyError(err)) return true;
          console.warn(`Move queue: looking up moved letter failed: ${err.message}`);
          // A lookup that keeps failing (a folder gone, say) ends like one that finds nothing.
          if (Date.now() - new Date(op.updated_at).getTime() > MOVE_AWAITING_UID_MAX_MS) await this._drop(op);
          else await query(`UPDATE message_moves SET next_attempt_at = now() + ($2::int * interval '1 millisecond') WHERE id = $1`, [op.id, MOVE_AWAITING_RETRY_MS]);
          continue;
        }
        if (uid) {
          const s = await this._settle(op, Number(uid));
          if (s?.row) settled.push(s);
        } else if (present?.length) {
          // The MOVE never happened: queue it again (not an attempt: nothing failed).
          await query(`UPDATE message_moves SET state = 'queued', next_attempt_at = now(), updated_at = now() WHERE id = $1 AND state = 'awaiting_uid'`, [op.id]);
          this._unexpect(op);
        } else if (Date.now() - new Date(op.updated_at).getTime() > MOVE_AWAITING_UID_MAX_MS) {
          // Neither in the destination by its Message-ID nor at the source: the row is dropped and
          // the destination sync inserts the letter as it finds it.
          await this._drop(op);
        } else {
          await query(`UPDATE message_moves SET next_attempt_at = now() + ($2::int * interval '1 millisecond') WHERE id = $1`, [op.id, MOVE_AWAITING_RETRY_MS]);
        }
      }
    } finally {
      await this._storeSettledFlags(account, settled);
      if (settled.some(s => s.needsProviderIds)) mgr._scheduleProviderIdBackfill(account);
    }
    return false;
  }

  async _markAwaiting(op) {
    await query(
      `UPDATE message_moves SET state = 'awaiting_uid', next_attempt_at = now() + ($2::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND state = 'moving'`,
      [op.id, MOVE_AWAITING_RETRY_MS]
    );
  }

  // Back to the queue without an attempt: the mailbox was busy or its logins are held back.
  async _release(ops) {
    if (!ops.length) return;
    await query(
      `UPDATE message_moves SET state = 'queued', updated_at = now() WHERE id = ANY($1::bigint[]) AND state = 'moving'`,
      [ops.map(o => o.id)]
    );
    for (const op of ops) this._unexpect(op);
  }

  async _retryLater(op, error, reverted) {
    const attempts = Number(op.attempts) + 1;
    if (attempts >= MOVE_MAX_ATTEMPTS) {
      console.warn(`Move queue: giving up on move ${op.id} after ${attempts} attempts: ${error}`);
      await this._revertInto(reverted, op, 'gave_up');
      return;
    }
    await query(
      `UPDATE message_moves SET state = 'queued', attempts = $2, last_error = $3,
              next_attempt_at = now() + ($4::int * interval '1 millisecond'), updated_at = now()
        WHERE id = $1 AND state = 'moving'`,
      [op.id, attempts, String(error).slice(0, 500), moveRetryDelayMs(attempts)]
    );
    this._unexpect(op);
  }

  // The server moved the letter and named its new uid. The row takes it (or the move that
  // follows it takes it as its source uid). Returns null when the move was already settled or
  // reverted, else { op, row, uid, needsProviderIds } (row null when no row takes the uid).
  async _settle(op, newUid) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query(
        'SELECT id, uid, folder, provider_message_id FROM messages WHERE id = $1 FOR UPDATE',
        [op.message_row_id]
      );
      const { rows: [cur] } = await tx.query('SELECT * FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [cur.id]);
      const { rows: [next] } = await tx.query(
        `UPDATE message_moves SET src_uid = $2, predecessor_id = NULL,
                set_seen = COALESCE(set_seen, $3), set_flagged = COALESCE(set_flagged, $4), updated_at = now()
          WHERE predecessor_id = $1
         RETURNING *`,
        [cur.id, newUid, cur.set_seen, cur.set_flagged]
      );
      if (next) return { op: cur, next, row: null, uid: newUid };
      if (!row || Number(row.uid) !== placeholderUid(cur.id)) return { op: cur, row: null, uid: newUid };
      if (cur.drop_row) {
        await tx.query('DELETE FROM messages WHERE id = $1', [row.id]);
        return { op: cur, row: null, uid: newUid };
      }
      // The server may name a uid that already has a row: on Gmail, MOVE into a label the letter
      // already carries answers with that label copy's uid. The moved row keeps its id (clients
      // hold it) and the other row goes.
      await tx.query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3 AND id <> $4',
        [cur.account_id, cur.dest_folder, newUid, row.id]
      );
      // synced_at keeps a reconcile that took its server snapshot before now from judging the new
      // uid. A flag set while the move was pending gets a fresh local-wins window: the letter
      // arrived with its old flags, and they are stored right after this.
      await tx.query(
        `UPDATE messages SET uid = $2, synced_at = NOW(),
                read_changed_at = CASE WHEN $3::boolean IS NULL THEN read_changed_at ELSE NOW() END,
                star_changed_at = CASE WHEN $4::boolean IS NULL THEN star_changed_at ELSE NOW() END
          WHERE id = $1`,
        [row.id, newUid, cur.set_seen, cur.set_flagged]
      );
      return { op: cur, row, uid: newUid, needsProviderIds: !row.provider_message_id };
    });
    if (!out) return null;
    this._unguard(out.op.id, { lingerSource: true });
    this._unexpect(out.op);
    if (out.next) {
      this._guard(out.next);
      this.kick(out.next.account_id);
    }
    return out;
  }

  // The move cannot be done. The row goes back to the letter's server location, or, when a move
  // follows this one, that move starts from there instead. Returns { op, row } for the notice
  // (row null when nothing went back), or null when the move was already settled.
  async _revert(op, reason) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query(
        'SELECT id, uid, folder, is_read FROM messages WHERE id = $1 FOR UPDATE',
        [op.message_row_id]
      );
      const { rows: [cur] } = await tx.query('SELECT * FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [cur.id]);
      const { rows: [next] } = await tx.query(
        `UPDATE message_moves SET src_folder = $2, src_uid = $3, predecessor_id = $4, updated_at = now()
          WHERE predecessor_id = $1
         RETURNING *`,
        [cur.id, cur.src_folder, cur.src_uid, cur.predecessor_id]
      );
      if (next) return { op: cur, next, row: null };
      if (!row || Number(row.uid) !== placeholderUid(cur.id)) return { op: cur, row: null };
      const backUid = cur.src_uid ?? placeholderUid(cur.predecessor_id);
      await tx.query(
        'DELETE FROM messages WHERE account_id = $1 AND folder = $2 AND uid = $3 AND id <> $4',
        [cur.account_id, cur.src_folder, backUid, row.id]
      );
      await tx.query('UPDATE messages SET folder = $2, uid = $3, synced_at = NOW() WHERE id = $1', [row.id, cur.src_folder, backUid]);
      return { op: cur, row };
    });
    if (!out) return null;
    this._unguard(out.op.id);
    this._unexpect(out.op);
    if (out.next) {
      this._guard(out.next);
      this.kick(out.next.account_id);
      return out;
    }
    if (out.row) {
      const { op: cur, row } = out;
      const unread = row.is_read ? 0 : 1;
      if (!cur.drop_row) adjustFolderCounts(cur.account_id, cur.dest_folder, -1, -unread);
      adjustFolderCounts(cur.account_id, cur.src_folder, 1, unread);
      // A read/star change made while the move was pending is kept and pushed at the source.
      if (cur.set_seen != null) this.mgr._enqueueFlagPush(cur.account_id, row.id, '\\Seen', cur.set_seen);
      if (cur.set_flagged != null) this.mgr._enqueueFlagPush(cur.account_id, row.id, '\\Flagged', cur.set_flagged);
      console.warn(`Move queue: move ${cur.id} ${cur.src_folder} -> ${cur.dest_folder} reverted (${reason})`);
    }
    return out;
  }

  async _revertInto(reverted, op, reason) {
    const out = await this._revert(op, reason);
    if (out?.row) reverted.push({ ...out, reason });
  }

  // Neither place has the letter where we can find it: the move and its row go, and the syncs
  // insert the letter wherever the server has it. A move that follows this one (the letter was
  // moved again meanwhile) waits for a source uid that will never come, so it goes too, with the
  // row when the row is at its placeholder.
  async _drop(op) {
    const out = await withTransaction(async (tx) => {
      const { rows: [row] } = await tx.query('SELECT id, uid FROM messages WHERE id = $1 FOR UPDATE', [op.message_row_id]);
      const { rows: [cur] } = await tx.query('SELECT id FROM message_moves WHERE id = $1 FOR UPDATE', [op.id]);
      if (!cur) return null;
      await tx.query('DELETE FROM message_moves WHERE id = $1', [op.id]);
      const { rows: next } = await tx.query('DELETE FROM message_moves WHERE predecessor_id = $1 RETURNING *', [op.id]);
      const ids = [op.id, ...next.map(n => n.id)];
      if (row && ids.some(id => Number(row.uid) === placeholderUid(id))) await tx.query('DELETE FROM messages WHERE id = $1', [row.id]);
      return { next };
    });
    if (!out) return;
    console.warn(`Move queue: move ${op.id} to ${op.dest_folder}: new uid not found, row dropped for the next sync`);
    this._unguard(op.id);
    this._unexpect(op);
    for (const n of out.next) this._unguard(n.id);
  }

  // Read/star changes made while the moves were pending, now stored at the destination. A store
  // that fails goes to the flag-push queue like any other.
  async _storeSettledFlags(account, settled) {
    for (const [flag, col] of Object.entries(FLAG_COLUMNS)) {
      for (const value of [true, false]) {
        const items = settled.filter(s => s.row && s.op[col] === value);
        const byFolder = new Map();
        for (const s of items) {
          if (!byFolder.has(s.op.dest_folder)) byFolder.set(s.op.dest_folder, []);
          byFolder.get(s.op.dest_folder).push(s);
        }
        for (const [folder, list] of byFolder) {
          try {
            await this.mgr.setFlags(account, folder, list.map(s => s.uid), flag, value, { background: true });
            for (const s of list) this.mgr._resolveFlagPush(account.id, s.row.id, flag);
          } catch (err) {
            console.warn(`Move queue: storing ${flag}=${value} after a move failed: ${err.message}`);
            for (const s of list) this.mgr._enqueueFlagPush(account.id, s.row.id, flag, value);
          }
        }
      }
    }
  }

  // Tell every client which rows went back, per source folder, and refresh the lists.
  _notifyReverted(accountId, reverted) {
    if (!reverted.length) return;
    const bySource = new Map();
    const folders = new Set();
    for (const { op, row, reason } of reverted) {
      const key = `${op.src_folder}\n${reason}`;
      if (!bySource.has(key)) bySource.set(key, { folder: op.src_folder, reason, ids: [] });
      bySource.get(key).ids.push(row.id);
      folders.add(op.src_folder);
      folders.add(op.dest_folder);
    }
    for (const notice of bySource.values()) {
      this.mgr.broadcast({ type: 'move_reverted', accountId, ...notice });
    }
    for (const folder of folders) this.mgr.broadcast({ type: 'folder_updated', folder, accountId });
  }
}
