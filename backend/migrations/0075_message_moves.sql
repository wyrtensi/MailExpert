-- The durable queue of DB-first moves (services/moveQueue.js). A user's move, archive, delete to
-- Trash or spam/not-spam changes the message row at once: it goes to the destination folder with a
-- placeholder uid, -id of its move here, and the MOVE on the mail server runs later from this row.
-- The rows survive a restart and are resumed at startup.
--
-- src_folder/src_uid: where the letter is on the server. src_uid is NULL while an earlier move of
-- the same letter (predecessor_id) is still in flight; that move writes it once the server has
-- named the letter's new uid.
-- set_seen/set_flagged: a read or star change made while the move was pending, stored at the
-- destination after the MOVE (the letter has no server location to store it at before that).
-- drop_row: the destination is not synced (Gmail All Mail), so the row is deleted once moved.
-- moved_by: the user whose move this is (the last one to move the letter while it was queued).
-- A revert is journaled for them and only they get the move_reverted notice.
-- state: queued (waiting for its turn or a retry), moving (claimed by the worker, MOVE on its way),
-- awaiting_uid (moved, but the server did not name the new uid; it is looked up).
-- claimed_at: when the worker claimed the move, renewed right before its MOVE: a lease. A move
-- left 'moving' by a run that failed is swept back once the lease runs out.
-- awaiting_since: when the move last became awaiting_uid; the clock of the give-up
-- (MOVE_AWAITING_UID_MAX_MS), which nothing else touches (a flag change on the move does not).
-- sent_at: set right before the MOVE is sent. A move swept back or recovered without it is queued
-- again (the MOVE never went out); with it, it is looked up like a move whose answer was lost.
CREATE TABLE IF NOT EXISTS message_moves (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  message_row_id uuid NOT NULL,
  message_id_header text,
  src_folder text NOT NULL,
  src_uid bigint,
  dest_folder text NOT NULL,
  predecessor_id bigint,
  drop_row boolean NOT NULL DEFAULT false,
  moved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  set_seen boolean,
  set_flagged boolean,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'moving', 'awaiting_uid')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  awaiting_since timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_message_moves_account ON message_moves (account_id, state, id);
CREATE INDEX IF NOT EXISTS idx_message_moves_row ON message_moves (message_row_id);
CREATE INDEX IF NOT EXISTS idx_message_moves_predecessor ON message_moves (predecessor_id) WHERE predecessor_id IS NOT NULL;
