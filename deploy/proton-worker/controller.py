"""Login/lifecycle controller for the managed Proton Bridge worker.

One global login slot serialises the whole native challenge chain. The slot is held from
Login until a terminal native event has been reconciled (attempt-owned users removed and
confirmed absent) or the native process has been recovered and the users it may have
created have been reconciled against the snapshot taken before the attempt. Cancel and TTL
only change the public state. Passwords and challenge secrets are passed straight to the
native adapter and are never stored, persisted or logged.

Committed state is one link per (native user ID, address): several addresses of one Proton
account can be linked, each with its own generation. The native user is removed only when
its last link is removed.
"""

import json
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path

LOGIN_TTL_SECONDS = 600
REMOVAL_RETRY_SECONDS = 120
MAX_REMOVAL_RECOVERIES = 2
MAX_RECONCILE_FAILURES = 5
RECONCILE_BACKOFF_CAP = 60
RECOVERY_BACKOFF_CAP = 300
SNAPSHOT_WAIT_SECONDS = 60
# A gate whose holder stops renewing it (a backup killed without its exit trap) reopens.
SNAPSHOT_TTL_SECONDS = 300
# DELETEs of leases not (yet) granted, kept so that a late grant is released at once.
CANCELLED_LEASES_KEPT = 4096
CONNECTED = 2
ACTIVE_STATES = {'starting', 'authenticating', 'needs_2fa', 'needs_second_password', 'checking'}
TERMINAL_STATES = {'connected', 'failed', 'cancelled', 'expired'}
CHALLENGES = {'2fa': 'needs_2fa', 'second_password': 'needs_second_password'}
RETRYABLE_ERRORS = {'tfa_error', 'two_passwords_error'}
ERROR_CODES = {'bad_password': 'invalid_credentials', 'verification': 'verification_required'}
JOURNAL = 'controller.json'
# Operation IDs (UUIDs) and native Proton user IDs: base64/base64url with optional '=' padding.
# Never '/', '.', '%' or whitespace, so an ID cannot change a path or a journal key.
ID_PATTERN = re.compile(r'(?=[A-Za-z0-9+_=-]{1,128}\Z)[A-Za-z0-9+_-]+={0,2}\Z')


class WorkerError(Exception):
    """Failure with an allowlisted code; the message is the code itself."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


class Operation:
    def __init__(self, operation_id, email, created_at, preexisting=()):
        self.id = operation_id
        self.email = email
        self.state = 'authenticating'
        self.userId = None
        self.createdByAttempt = False
        self.errorCode = None
        self.created_at = created_at
        self.ended_at = None
        self.committed = False
        self.preexisting = set(preexisting)
        self.reconcile = False
        self.split_requested = False

    def to_dict(self):
        return {'id': self.id, 'state': self.state, 'userId': self.userId,
                'createdByAttempt': self.createdByAttempt, 'errorCode': self.errorCode}


def _log(code):
    os.write(2, ('proton-worker: %s\n' % code).encode('ascii', 'replace'))


def _safe_id(value):
    if not isinstance(value, str) or not ID_PATTERN.match(value):
        raise WorkerError('worker_invalid_request')
    return value


def _safe_email(value):
    if not isinstance(value, str) or '@' not in value or len(value) > 320:
        raise WorkerError('worker_invalid_request')
    return value


class BridgeController:
    def __init__(self, native, state_dir, clock=time.monotonic, recovery_seconds=30,
                 ttl_seconds=LOGIN_TTL_SECONDS, snapshot_wait_seconds=SNAPSHOT_WAIT_SECONDS,
                 snapshot_ttl_seconds=SNAPSHOT_TTL_SECONDS):
        self.native = native
        self.snapshot_wait_seconds = snapshot_wait_seconds
        self.snapshot_ttl_seconds = snapshot_ttl_seconds
        self.snapshot_expires_at = None
        self.cancelled_leases = OrderedDict()
        self.state_dir = Path(state_dir)
        self.clock = clock
        self.recovery_seconds = recovery_seconds
        self.ttl_seconds = ttl_seconds
        self.lock = threading.RLock()
        self.drained = threading.Condition(self.lock)
        # Send leases live in memory only: they never expire by time, and only a controlled
        # recreation of the worker (after the old backend has stopped) forgets them.
        self.send_leases = set()
        self.snapshot = None
        self.operations = {}
        self.links = {}
        self.pending_removals = {}
        self.slot = None
        self.started = False
        self.native_lost = False
        self.recovering = False
        self.closed = False
        self.next_start_at = 0
        self.reconcile_failures = 0
        self.next_reconcile_at = 0
        self.recovery_streak = 0
        self.last_recovery_at = None
        self.next_recovery_at = 0
        self._journal_text = None
        self._load()

    # -- journal -----------------------------------------------------------------------
    def _load(self):
        try:
            data = json.loads((self.state_dir / JOURNAL).read_text())
        except FileNotFoundError:
            return
        now = self.clock()
        for item in data.get('operations', []):
            operation = Operation(item['id'], item.get('email', ''), now, item.get('preexisting', []))
            operation.state = item['state']
            operation.userId = item.get('userId')
            operation.createdByAttempt = bool(item.get('createdByAttempt'))
            operation.errorCode = item.get('errorCode')
            operation.committed = bool(item.get('committed'))
            operation.reconcile = bool(item.get('reconcile'))
            if operation.state in ACTIVE_STATES:
                # The worker stopped mid-attempt: reconcile users created since the snapshot.
                operation.state, operation.errorCode = 'failed', 'worker_unavailable'
                operation.reconcile = True
            if operation.state in TERMINAL_STATES:
                operation.ended_at = now
            self.operations[operation.id] = operation
        for link in data.get('links', []):
            self.links[(link['userId'], link['email'].lower())] = dict(link)
        for user_id, item in data.get('pendingRemovals', {}).items():
            self.pending_removals[user_id] = self._removal(item.get('reason', 'remove'), now)

    def _persist(self):
        data = {
            'operations': [dict(op.to_dict(), email=op.email, committed=op.committed,
                                preexisting=sorted(op.preexisting), reconcile=op.reconcile)
                           for op in self.operations.values()],
            'links': sorted(self.links.values(), key=lambda link: (link['userId'], link['email'])),
            'pendingRemovals': {user_id: {'reason': item['reason']}
                                for user_id, item in self.pending_removals.items()},
        }
        text = json.dumps(data, sort_keys=True)
        if text != self._journal_text:
            self._write(text)
            self._journal_text = text

    def _write(self, text):
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = self.state_dir / JOURNAL
        temporary = self.state_dir / (JOURNAL + '.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)

    # -- process -----------------------------------------------------------------------
    def _needs_bridge(self):
        return bool(self.links or self.pending_removals or
                    self._reconcile_pending())

    def _reconcile_pending(self):
        return any(op.reconcile for op in list(self.operations.values()))

    def _alive(self):
        running = getattr(self.native, 'running', None)
        return self.started and not self.native_lost and (running is None or running())

    def boot(self):
        """Start Bridge eagerly when links, removals or crash reconciliation exist."""
        with self.lock:
            if self._needs_bridge():
                self._ensure_started()
                self._persist()

    def _ensure_started(self):
        if self._alive():
            return
        if self.snapshot is not None:
            raise WorkerError('maintenance_busy')
        try:
            if self.started:
                # Bridge died or lost its stream: restart it instead of failing forever.
                self.native.recover(self._on_event)
            else:
                self.native.start(self._on_event)
        except Exception as error:  # noqa: BLE001
            self.started = False
            _log('native_start_failed ' + type(error).__name__)
            raise WorkerError('worker_unavailable') from None
        self.started, self.native_lost = True, False
        # Any successful (re)start reconciles: crash-pending orphans, lost terminal events and
        # removals the previous process may have forgotten, however Bridge got started.
        self._after_restart()

    def health(self):
        # Lock-free on purpose: plain attribute reads, never blocked by native calls.
        if self.snapshot is not None:
            state = 'snapshot'
        elif self.recovering:
            state = 'recovering'
        elif self._alive():
            state = 'running'
        elif self._needs_bridge():
            state = 'degraded'
        else:
            state = 'idle'
        return {'state': state, 'loginBusy': self._busy(), 'linkedAddresses': len(self.links),
                'sendLeases': len(self.send_leases), 'snapshotId': self.snapshot,
                'pendingRemovals': len(self.pending_removals),
                'stuckRemovals': sum(1 for item in list(self.pending_removals.values())
                                     if item.get('stuck'))}

    def shutdown(self):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            started = self.started
            self.started = False
        if started:
            self.native.shutdown()

    # -- login -------------------------------------------------------------------------
    def _busy(self):
        return (self.slot is not None or self.recovering or self.snapshot is not None or self._reconcile_pending() or
                any(item['reason'] == 'attempt' and not item.get('stuck')
                    for item in list(self.pending_removals.values())))

    def start_connection(self, operation_id, email, password):
        _safe_id(operation_id)
        _safe_email(email)
        if not isinstance(password, str) or not password:
            raise WorkerError('worker_invalid_request')
        with self.lock:
            if self.closed:
                raise WorkerError('worker_unavailable')
            existing = self.operations.get(operation_id)
            if existing is not None:
                if existing.email.lower() != email.lower():
                    raise WorkerError('operation_conflict')
                return existing
            if self._busy():
                raise WorkerError('login_busy')
            self._ensure_started()
            if self._busy():
                raise WorkerError('login_busy')
            try:
                preexisting = self.native.list_users()
            except Exception:  # noqa: BLE001
                raise WorkerError('worker_unavailable') from None
            operation = Operation(operation_id, email, self.clock(), preexisting)
            self.operations[operation_id] = operation
            self.slot = operation_id
            self._persist()
            try:
                self.native.login(email, password)
            except Exception as error:  # noqa: BLE001
                # The RPC may have reached Bridge; keep the slot until recovery.
                _log('native_login_failed ' + type(error).__name__)
                self._end(operation, 'failed', 'worker_unavailable')
                self._persist()
            return operation

    def continue_connection(self, operation_id, challenge, secret):
        with self.lock:
            operation = self._operation(operation_id)
            if challenge not in CHALLENGES or operation.state != CHALLENGES[challenge] or \
                    self.slot != operation_id or not isinstance(secret, str) or not secret:
                raise WorkerError('invalid_challenge')
            operation.state = 'authenticating'
            operation.errorCode = None
            self._persist()
            try:
                self.native.continue_login(operation.email, challenge, secret)
            except Exception as error:  # noqa: BLE001
                _log('native_continue_failed ' + type(error).__name__)
                self._end(operation, 'failed', 'worker_unavailable')
            self._persist()
            return operation

    def cancel_connection(self, operation_id):
        with self.lock:
            operation = self._operation(operation_id)
            if operation.state == 'connected' and not operation.committed:
                self._end(operation, 'cancelled')
                self._drop_attempt_user(operation)
            elif operation.state in ACTIVE_STATES:
                self._stop_attempt(operation, 'cancelled')
            self._persist()
            return operation

    def connection_status(self, operation_id):
        with self.lock:
            return self._operation(operation_id)

    def commit_connection(self, operation_id, user_id, generation, previous_generation=None):
        _safe_id(user_id)
        _safe_id(generation)
        with self.lock:
            self._admit()
            operation = self._operation(operation_id)
            if operation.state != 'connected' or operation.userId != user_id:
                raise WorkerError('not_connected')
            if user_id in self.pending_removals:
                raise WorkerError('operation_conflict')
            key = (user_id, operation.email.lower())
            existing = self.links.get(key)
            if existing is not None and existing['generation'] != generation and \
                    previous_generation != existing['generation']:
                raise WorkerError('generation_mismatch')
            self.links[key] = {'userId': user_id, 'email': operation.email, 'generation': generation}
            if not operation.committed:
                operation.committed = True
                operation.ended_at = self.clock()
            self._persist()
            return operation

    def credentials(self, user_id, operation_id=None, generation=None, email=None):
        _safe_id(user_id)
        with self.lock:
            self._admit()
            if (operation_id is None) == (generation is None):
                raise WorkerError('worker_invalid_request')
            if operation_id is not None:
                operation = self._operation(operation_id)
                if operation.state != 'connected' or operation.userId != user_id:
                    raise WorkerError('not_connected')
                email = operation.email
            else:
                link = self.links.get((user_id, _safe_email(email).lower()))
                if link is None:
                    raise WorkerError('not_found')
                if link['generation'] != generation:
                    raise WorkerError('generation_mismatch')
                email = link['email']
            if user_id in self.pending_removals:
                raise WorkerError('not_connected')
            self._ensure_started()
            try:
                user = self.native.get_user(user_id)
            except Exception:  # noqa: BLE001
                raise WorkerError('worker_unavailable') from None
            if not self._owns(user, user_id, email):
                raise WorkerError('address_mismatch')
            if user['state'] != CONNECTED or not user['splitMode']:
                raise WorkerError('not_connected')
            try:
                result = self.native.credentials(user_id, email)
            except Exception as error:  # noqa: BLE001
                code = getattr(error, 'code', None)
                raise WorkerError('address_mismatch' if code == 'address_mismatch'
                                  else 'worker_unavailable') from None
            if result.get('userId') != user_id or result.get('email') != email:
                raise WorkerError('address_mismatch')
            return result

    def remove_user(self, user_id, generation, email):
        """Remove one (user, address) link; the native user goes with its last link."""
        _safe_id(user_id)
        _safe_id(generation)
        _safe_email(email)
        with self.lock:
            self._admit()
            key = (user_id, email.lower())
            link = self.links.get(key)
            if link is None:
                state = 'removing' if user_id in self.pending_removals else 'removed'
                return {'userId': user_id, 'state': state}
            if link['generation'] != generation:
                raise WorkerError('generation_mismatch')
            others = [k for k in self.links if k[0] == user_id and k != key]
            if not others:
                self._ensure_started()
            del self.links[key]
            if others or self._hand_over(user_id):
                self._persist()
                return {'userId': user_id, 'state': 'unlinked'}
            if user_id not in self.pending_removals:
                self._begin_removal(user_id, 'remove')
            self._persist()
            state = 'removing' if user_id in self.pending_removals else 'removed'
            return {'userId': user_id, 'state': state}

    # -- snapshot gate and send leases ------------------------------------------------
    def _admit(self):
        if self.snapshot is not None:
            raise WorkerError('maintenance_busy')

    def _login_active(self):
        return (self.slot is not None or self.recovering or
                any(item['reason'] == 'attempt' and not item.get('stuck')
                    for item in list(self.pending_removals.values())))

    def acquire_send_lease(self, lease_id=None):
        """Reserve one actual Proton send; refused while a snapshot holds the gate.

        The backend names the lease, so it can cancel a request it gave up on: a DELETE that
        arrives first is remembered and the late grant is refused (lease_cancelled). Granting
        an id already held is idempotent.
        """
        if lease_id is None:
            lease_id = uuid.uuid4().hex
        _safe_id(lease_id)
        with self.lock:
            if self.cancelled_leases.pop(lease_id, None) is not None:
                raise WorkerError('lease_cancelled')
            if lease_id in self.send_leases:
                return {'leaseId': lease_id}
            if self.closed:
                raise WorkerError('worker_unavailable')
            self._admit()
            self.send_leases.add(lease_id)
            return {'leaseId': lease_id}

    def release_send_lease(self, lease_id):
        _safe_id(lease_id)
        with self.lock:
            released = lease_id in self.send_leases
            self.send_leases.discard(lease_id)
            if not released:
                self.cancelled_leases[lease_id] = True
                while len(self.cancelled_leases) > CANCELLED_LEASES_KEPT:
                    self.cancelled_leases.popitem(last=False)
            self.drained.notify_all()
            return {'released': released}

    def snapshot_begin(self, snapshot_id):
        """Close the gate, drain sends and logins, then stop Bridge and wait for its exit.

        Bounded by snapshot_wait_seconds: a live sender that does not finish in time makes
        the snapshot busy and the gate opens again. A lease is never presumed dead.
        """
        _safe_id(snapshot_id)
        with self.lock:
            if self.snapshot is not None:
                if self.snapshot == snapshot_id:
                    return self.health()
                if self.clock() < self.snapshot_expires_at:
                    raise WorkerError('operation_conflict')
                # The previous holder stopped renewing: its gate is taken over as it is.
                _log('snapshot_reclaimed')
                self.snapshot = snapshot_id
                self.snapshot_expires_at = self.clock() + self.snapshot_ttl_seconds
                return self.health()
            if self.closed:
                raise WorkerError('worker_unavailable')
            self.snapshot = snapshot_id
            self.snapshot_expires_at = self.clock() + self.snapshot_ttl_seconds
            try:
                drained = self.drained.wait_for(
                    lambda: not self.send_leases and not self._login_active(),
                    timeout=self.snapshot_wait_seconds)
                if not drained:
                    raise WorkerError('snapshot_busy')
                if self.started:
                    self.started = False
                    try:
                        # Quit, then the adapter waits for the process to exit.
                        self.native.shutdown()
                    except Exception as error:  # noqa: BLE001
                        self.started, self.native_lost = True, True
                        _log('snapshot_stop_failed ' + type(error).__name__)
                        raise WorkerError('worker_unavailable') from None
                self._persist()
            except BaseException:
                self.snapshot = None
                self.drained.notify_all()
                raise
            _log('snapshot_begin')
            return self.health()

    def snapshot_end(self, snapshot_id):
        """Open the gate again and start Bridge when links or removals need it."""
        _safe_id(snapshot_id)
        with self.lock:
            if self.snapshot is None:
                return self.health()
            if self.snapshot != snapshot_id:
                raise WorkerError('operation_conflict')
            self._open_gate('snapshot_end')
            return self.health()

    def snapshot_renew(self, snapshot_id):
        """The holder is alive: the gate stays closed snapshot_ttl_seconds longer."""
        _safe_id(snapshot_id)
        with self.lock:
            if self.snapshot != snapshot_id:
                raise WorkerError('operation_conflict')
            self.snapshot_expires_at = self.clock() + self.snapshot_ttl_seconds
            return self.health()

    def _open_gate(self, reason):
        self.snapshot = None
        self.snapshot_expires_at = None
        self.drained.notify_all()
        if self._needs_bridge():
            try:
                self._ensure_started()
            except WorkerError:
                # tick() starts it again with its backoff.
                self.next_start_at = self.clock() + self.recovery_seconds
        self._persist()
        _log(reason)

    # -- timers ------------------------------------------------------------------------
    def tick(self):
        recover = False
        with self.lock:
            if self.closed:
                return
            if self.snapshot is not None:
                if self.clock() < self.snapshot_expires_at:
                    # Bridge is stopped on purpose for a state capture: nothing restarts it.
                    return
                self._open_gate('snapshot_expired')
            now = self.clock()
            self._expire(now)
            if not self.recovering:
                can_recover = now >= self.next_recovery_at
                recover = self._removal_timers(now, can_recover)
                holder = self.operations.get(self.slot)
                if (holder is not None and holder.state in TERMINAL_STATES and
                        holder.ended_at is not None and
                        now - holder.ended_at >= self.recovery_seconds and
                        holder.userId not in self.pending_removals):
                    holder.reconcile = True
                    recover = True
                if self.started and not self._alive():
                    if self._needs_bridge() or self.slot is not None:
                        recover = True
                    else:
                        # Nothing to serve: forget the dead process; next use starts it lazily.
                        self.started = False
                        self.native_lost = False
                elif not self.started and self._needs_bridge() and now >= self.next_start_at:
                    try:
                        self._ensure_started()
                    except WorkerError:
                        self.next_start_at = now + self.recovery_seconds
                if (not recover and self._alive() and self._reconcile_pending() and
                        now >= self.next_reconcile_at):
                    # A failed GetUserList must not leave logins blocked while Bridge lives.
                    if (not self._reconcile_all() and
                            self.reconcile_failures >= MAX_RECONCILE_FAILURES):
                        recover = True
                if recover and not can_recover:
                    recover = False
            self._prune(now)
            if recover:
                self.recovering = True
            self._persist()
        if recover:
            self._recover()

    def _expire(self, now):
        for operation in list(self.operations.values()):
            expired = now - operation.created_at >= self.ttl_seconds
            if expired and operation.state in ACTIVE_STATES:
                self._stop_attempt(operation, 'expired')
            elif expired and operation.state == 'connected' and not operation.committed:
                self._end(operation, 'expired')
                self._drop_attempt_user(operation)

    def _removal_timers(self, now, can_recover=True):
        """Retry removals; a stuck attempt removal gets bounded process recoveries."""
        recover = False
        for user_id, item in list(self.pending_removals.items()):
            if now - item['since'] < REMOVAL_RETRY_SECONDS:
                continue
            if item['reason'] == 'attempt' and not item.get('stuck'):
                if item['recoveries'] < MAX_REMOVAL_RECOVERIES:
                    if not can_recover:
                        continue
                    item['recoveries'] += 1
                    item['since'] = now
                    recover = True
                    continue
                item['stuck'] = True
                _log('native_removal_stuck')
            self._retry_removal(user_id)
        return recover

    def _prune(self, now):
        for operation_id, operation in list(self.operations.items()):
            if (operation.state in TERMINAL_STATES and operation.ended_at is not None and
                    now - operation.ended_at >= self.ttl_seconds and
                    self.slot != operation_id and not operation.reconcile):
                del self.operations[operation_id]

    def _recover(self):
        _log('native_recovery')
        now = self.clock()
        if self.last_recovery_at is not None and now - self.last_recovery_at < RECOVERY_BACKOFF_CAP:
            self.recovery_streak += 1
        else:
            self.recovery_streak = 0
        self.last_recovery_at = now
        # Back off restarts of a Bridge that keeps dying: recovery_seconds, doubled per streak.
        self.next_recovery_at = now + min(self.recovery_seconds * 2 ** self.recovery_streak,
                                          RECOVERY_BACKOFF_CAP)
        try:
            self.native.recover(self._on_event)
            ok = True
        except Exception as error:  # noqa: BLE001
            _log('native_recovery_failed ' + type(error).__name__)
            ok = False
        with self.lock:
            self.recovering = False
            self.started = ok and not self.closed
            self.native_lost = False
            if self.started:
                self._after_restart()
            else:
                holder = self.operations.get(self.slot)
                if holder is not None:
                    holder.ended_at = self.clock()
            self._persist()

    def _after_restart(self):
        """Reconcile users a lost terminal event may have left, then free the slot."""
        earlier_removals = list(self.pending_removals)
        self.reconcile_failures = 0
        self.next_reconcile_at = 0
        self._reconcile_all()
        # A restarted process forgot in-flight deletions: re-issue the earlier ones.
        for user_id in earlier_removals:
            self._retry_removal(user_id)

    def _reconcile_all(self):
        """Reconcile pending ops; on failure schedule a retry with exponential backoff."""
        reconciled = True
        for operation in list(self.operations.values()):
            if operation.reconcile:
                reconciled = self._reconcile_orphans(operation) and reconciled
        holder = self.operations.get(self.slot)
        if reconciled and (holder is None or holder.state in TERMINAL_STATES):
            self.slot = None
        elif holder is not None:
            holder.ended_at = self.clock()
        if reconciled:
            self.reconcile_failures = 0
        else:
            self.reconcile_failures += 1
            self.next_reconcile_at = self.clock() + min(2 ** self.reconcile_failures,
                                                        RECONCILE_BACKOFF_CAP)
        return reconciled

    def _reconcile_orphans(self, operation):
        try:
            users = set(self.native.list_users())
        except Exception as error:  # noqa: BLE001
            _log('native_reconcile_failed ' + type(error).__name__)
            return False
        known = set(operation.preexisting) | {key[0] for key in self.links}
        known |= set(self.pending_removals)
        known |= {op.userId for op in self.operations.values()
                  if op is not operation and op.userId and op.state in ('connected', 'checking')}
        for user_id in sorted(users - known):
            _log('native_orphan_user')
            self._begin_removal(user_id, 'attempt')
        operation.reconcile = False
        return True

    # -- events ------------------------------------------------------------------------
    def _on_event(self, event):
        with self.lock:
            kind = event.get('kind')
            operation = self.operations.get(self.slot)
            if kind in ('needs_2fa', 'needs_second_password'):
                if operation is not None and operation.state in ACTIVE_STATES:
                    operation.state = kind
            elif kind == 'error':
                self._on_login_error(operation, event.get('code'))
            elif kind == 'hv':
                if operation is not None and operation.state in ACTIVE_STATES:
                    self._stop_attempt(operation, 'failed', 'verification_required')
            elif kind in ('finished', 'already_logged_in'):
                self._on_login_finished(operation, kind, event.get('userId'))
            elif kind == 'user_changed':
                self._on_user_changed(event.get('userId'))
            elif kind == 'stream_ended':
                _log('native_stream_ended')
                self.native_lost = True
            elif kind == 'no_keychain':
                _log('native_no_keychain')
            self._persist()

    def _on_login_error(self, operation, code):
        if operation is None:
            return
        if code in RETRYABLE_ERRORS:
            if operation.state in ACTIVE_STATES:
                operation.state = 'needs_2fa' if code == 'tfa_error' else 'needs_second_password'
                operation.errorCode = 'invalid_challenge'
            return
        if operation.state in ACTIVE_STATES:
            self._end(operation, 'failed', ERROR_CODES.get(code, 'login_failed'))
        self._release(operation)

    def _on_login_finished(self, operation, kind, user_id):
        if operation is None or not isinstance(user_id, str) or not user_id:
            return
        operation.userId = user_id
        operation.createdByAttempt = kind == 'finished' and user_id not in operation.preexisting
        if operation.state in ACTIVE_STATES:
            operation.state = 'checking'
            self._reconcile(operation)
        else:
            self._drop_attempt_user(operation)
            self._release(operation)

    def _on_user_changed(self, user_id):
        if user_id in self.pending_removals:
            try:
                present = user_id in self.native.list_users()
            except Exception:  # noqa: BLE001
                present = True
            if not present:
                self.pending_removals.pop(user_id)
                _log('native_user_removed')
        for operation in self.operations.values():
            if operation.state == 'checking' and operation.userId == user_id:
                self._reconcile(operation)

    def _reconcile(self, operation):
        """Address membership, CONNECTED state and confirmed split mode before probes."""
        try:
            user = self.native.get_user(operation.userId)
        except Exception:  # noqa: BLE001
            return
        if not self._owns(user, operation.userId, operation.email):
            self._end(operation, 'failed', 'address_mismatch')
            self._drop_attempt_user(operation)
            self._release(operation)
            return
        if user['state'] != CONNECTED:
            return
        if user['splitMode']:
            operation.state = 'connected'
            operation.errorCode = None
            self._release(operation)
            return
        if not operation.split_requested:
            operation.split_requested = True
            try:
                self.native.set_split(operation.userId)
            except Exception as error:  # noqa: BLE001
                _log('native_split_failed ' + type(error).__name__)

    # -- helpers -----------------------------------------------------------------------
    def _operation(self, operation_id):
        operation = self.operations.get(operation_id) if isinstance(operation_id, str) else None
        if operation is None:
            raise WorkerError('not_found')
        return operation

    @staticmethod
    def _owns(user, user_id, email):
        addresses = [address.lower() for address in user.get('addresses', [])]
        return user.get('id') == user_id and email.lower() in addresses

    def _end(self, operation, state, code=None):
        operation.state = state
        operation.errorCode = code
        operation.ended_at = self.clock()

    def _stop_attempt(self, operation, state, code=None):
        """Change public state; the slot stays until a terminal event or recovery."""
        login_finished = operation.state == 'checking'
        self._end(operation, state, code)
        if login_finished:
            self._drop_attempt_user(operation)
            self._release(operation)
            return
        try:
            self.native.abort(operation.email)
        except Exception as error:  # noqa: BLE001
            _log('native_abort_failed ' + type(error).__name__)

    def _release(self, operation):
        if self.slot == operation.id:
            self.slot = None

    def _drop_attempt_user(self, operation):
        """Remove the native user an ended attempt created, unless something still uses it.

        A committed link of the user (another address) keeps it. A live attempt that signed in
        the same user (another address, not committed yet) keeps it too and inherits the
        clean-up: if that attempt ends without a commit, the user goes with it.
        """
        user_id = operation.userId
        if not operation.createdByAttempt or not user_id:
            return
        if any(key[0] == user_id for key in self.links) or self._hand_over(user_id, operation):
            return
        self._begin_removal(user_id, 'attempt')

    def _hand_over(self, user_id, ended=None):
        """Give the clean-up of a user to the live attempts that use it; False when none do."""
        heirs = [op for op in self.operations.values()
                 if op is not ended and op.userId == user_id and not op.committed and
                 (op.state in ACTIVE_STATES or op.state == 'connected')]
        for heir in heirs:
            heir.createdByAttempt = True
        return bool(heirs)

    def _removal(self, reason, now):
        return {'reason': reason, 'since': now, 'recoveries': 0, 'stuck': False}

    def _begin_removal(self, user_id, reason):
        item = self.pending_removals.get(user_id)
        if item is None:
            item = self.pending_removals[user_id] = self._removal(reason, self.clock())
        else:
            item['since'] = self.clock()
            if reason == 'remove':
                item['reason'] = reason
        try:
            self.native.remove_user(user_id)
        except Exception as error:  # noqa: BLE001
            _log('native_remove_failed ' + type(error).__name__)

    def _retry_removal(self, user_id):
        if user_id not in self.pending_removals:
            return
        try:
            present = user_id in self.native.list_users()
        except Exception as error:  # noqa: BLE001
            _log('native_list_failed ' + type(error).__name__)
            return
        if not present:
            self.pending_removals.pop(user_id)
            return
        self._begin_removal(user_id, self.pending_removals[user_id]['reason'])
