"""Login/lifecycle controller for the managed Proton Bridge worker.

One global login slot serialises the whole native challenge chain. The slot is held from
Login until a terminal native event has been reconciled (attempt-owned users removed and
confirmed absent) or the native process has been recovered; cancel and TTL only change the
public state. Passwords and challenge secrets are passed straight to the native adapter and
are never stored, persisted or logged.
"""

import json
import os
import re
import threading
import time
from pathlib import Path

LOGIN_TTL_SECONDS = 600
REMOVAL_RETRY_SECONDS = 120
CONNECTED = 2
ACTIVE_STATES = {'starting', 'authenticating', 'needs_2fa', 'needs_second_password', 'checking'}
TERMINAL_STATES = {'connected', 'failed', 'cancelled', 'expired'}
CHALLENGES = {'2fa': 'needs_2fa', 'second_password': 'needs_second_password'}
RETRYABLE_ERRORS = {'tfa_error', 'two_passwords_error'}
ERROR_CODES = {'bad_password': 'invalid_credentials', 'verification': 'verification_required'}
JOURNAL = 'controller.json'
ID_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,128}$')


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

    def to_dict(self):
        return {'id': self.id, 'state': self.state, 'userId': self.userId,
                'createdByAttempt': self.createdByAttempt, 'errorCode': self.errorCode}


def _log(code):
    os.write(2, ('proton-worker: %s\n' % code).encode('ascii', 'replace'))


def _safe_id(value):
    if not isinstance(value, str) or not ID_PATTERN.match(value):
        raise WorkerError('worker_invalid_request')
    return value


class BridgeController:
    def __init__(self, native, state_dir, clock=time.monotonic, recovery_seconds=30,
                 ttl_seconds=LOGIN_TTL_SECONDS):
        self.native = native
        self.state_dir = Path(state_dir)
        self.clock = clock
        self.recovery_seconds = recovery_seconds
        self.ttl_seconds = ttl_seconds
        self.lock = threading.RLock()
        self.operations = {}
        self.committed = {}
        self.pending_removals = {}
        self.slot = None
        self.started = False
        self.recovering = False
        self.closed = False
        self._load()

    # -- journal -----------------------------------------------------------------------
    def _load(self):
        try:
            data = json.loads((self.state_dir / JOURNAL).read_text())
        except FileNotFoundError:
            return
        now = self.clock()
        for item in data.get('operations', []):
            operation = Operation(item['id'], item.get('email', ''), now)
            operation.state = item['state']
            operation.userId = item.get('userId')
            operation.createdByAttempt = bool(item.get('createdByAttempt'))
            operation.errorCode = item.get('errorCode')
            operation.committed = bool(item.get('committed'))
            if operation.state in ACTIVE_STATES:
                operation.state, operation.errorCode = 'failed', 'worker_unavailable'
                if operation.createdByAttempt and operation.userId:
                    self.pending_removals[operation.userId] = {'reason': 'attempt', 'since': now}
            self.operations[operation.id] = operation
        self.committed = dict(data.get('committed', {}))
        for user_id, item in data.get('pendingRemovals', {}).items():
            self.pending_removals[user_id] = {'reason': item.get('reason', 'remove'), 'since': now}

    def _persist(self):
        data = {
            'operations': [dict(op.to_dict(), email=op.email, committed=op.committed)
                           for op in self.operations.values()],
            'committed': self.committed,
            'pendingRemovals': {user_id: {'reason': item['reason']}
                                for user_id, item in self.pending_removals.items()},
        }
        self.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        target = self.state_dir / JOURNAL
        temporary = self.state_dir / (JOURNAL + '.tmp')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as handle:
            json.dump(data, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)

    # -- process -----------------------------------------------------------------------
    def boot(self):
        """Start Bridge eagerly when committed users or pending removals exist."""
        with self.lock:
            if self.committed or self.pending_removals:
                self._ensure_started()
                for user_id in list(self.pending_removals):
                    self._retry_removal(user_id)
                self._persist()

    def _ensure_started(self):
        if self.started:
            return
        try:
            self.native.start(self._on_event)
        except Exception as error:  # noqa: BLE001
            _log('native_start_failed ' + type(error).__name__)
            raise WorkerError('worker_unavailable') from None
        self.started = True

    def health(self):
        with self.lock:
            running = getattr(self.native, 'running', lambda: self.started)()
            state = 'recovering' if self.recovering else ('running' if running else 'idle')
            return {'state': state, 'loginBusy': self._busy(),
                    'committedUsers': len(self.committed),
                    'pendingRemovals': len(self.pending_removals)}

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
        return (self.slot is not None or self.recovering or
                any(item['reason'] == 'attempt' for item in self.pending_removals.values()))

    def start_connection(self, operation_id, email, password):
        _safe_id(operation_id)
        if not isinstance(email, str) or '@' not in email or len(email) > 320 or \
                not isinstance(password, str) or not password:
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
                self._fail(operation, 'worker_unavailable')
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
                self._fail(operation, 'worker_unavailable')
            return operation

    def cancel_connection(self, operation_id):
        with self.lock:
            operation = self._operation(operation_id)
            if operation.state == 'connected' and not operation.committed:
                self._end(operation, 'cancelled')
                if operation.createdByAttempt:
                    self._begin_removal(operation.userId, 'attempt')
            elif operation.state in ACTIVE_STATES:
                self._stop_attempt(operation, 'cancelled')
            self._persist()
            return operation

    def connection_status(self, operation_id):
        with self.lock:
            return self._operation(operation_id)

    def commit_connection(self, operation_id, user_id, generation):
        _safe_id(user_id)
        _safe_id(generation)
        with self.lock:
            operation = self._operation(operation_id)
            if operation.state != 'connected' or operation.userId != user_id:
                raise WorkerError('not_connected')
            if user_id in self.pending_removals:
                raise WorkerError('operation_conflict')
            operation.committed = True
            self.committed[user_id] = {'generation': generation, 'email': operation.email}
            self._persist()
            return operation

    def credentials(self, user_id, operation_id=None, generation=None):
        _safe_id(user_id)
        with self.lock:
            if (operation_id is None) == (generation is None):
                raise WorkerError('worker_invalid_request')
            if operation_id is not None:
                operation = self._operation(operation_id)
                if operation.state != 'connected' or operation.userId != user_id:
                    raise WorkerError('not_connected')
                email = operation.email
            else:
                entry = self.committed.get(user_id)
                if entry is None:
                    raise WorkerError('not_found')
                if entry['generation'] != generation:
                    raise WorkerError('generation_mismatch')
                email = entry['email']
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

    def remove_user(self, user_id, generation):
        _safe_id(user_id)
        _safe_id(generation)
        with self.lock:
            entry = self.committed.get(user_id)
            if entry is None:
                return {'userId': user_id, 'state': 'removing' if user_id in self.pending_removals
                        else 'removed'}
            if entry['generation'] != generation:
                raise WorkerError('generation_mismatch')
            self._ensure_started()
            if user_id not in self.pending_removals:
                self._begin_removal(user_id, 'remove')
            self._persist()
            state = 'removing' if user_id in self.pending_removals else 'removed'
            return {'userId': user_id, 'state': state}

    # -- timers ------------------------------------------------------------------------
    def tick(self):
        with self.lock:
            now = self.clock()
            for operation in list(self.operations.values()):
                expired = now - operation.created_at >= self.ttl_seconds
                if expired and operation.state in ACTIVE_STATES:
                    self._stop_attempt(operation, 'expired')
                elif expired and operation.state == 'connected' and not operation.committed:
                    self._end(operation, 'expired')
                    if operation.createdByAttempt:
                        self._begin_removal(operation.userId, 'attempt')
            for user_id, item in list(self.pending_removals.items()):
                if now - item['since'] >= REMOVAL_RETRY_SECONDS:
                    self._retry_removal(user_id)
            holder = self.operations.get(self.slot)
            recover = (holder is not None and holder.state in TERMINAL_STATES and
                       holder.ended_at is not None and
                       now - holder.ended_at >= self.recovery_seconds and
                       holder.userId not in self.pending_removals)
            if recover:
                self.recovering = True
            self._persist()
        if recover:
            self._recover()

    def _recover(self):
        _log('native_recovery')
        try:
            self.native.recover(self._on_event)
            ok = True
        except Exception as error:  # noqa: BLE001
            _log('native_recovery_failed ' + type(error).__name__)
            ok = False
        with self.lock:
            self.recovering = False
            self.slot = None
            self.started = ok
            if ok:
                for user_id in list(self.pending_removals):
                    self._retry_removal(user_id)
            self._persist()

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
                if operation is not None:
                    if operation.state in ACTIVE_STATES:
                        self._stop_attempt(operation, 'failed', 'verification_required')
            elif kind in ('finished', 'already_logged_in'):
                self._on_login_finished(operation, kind, event.get('userId'))
            elif kind == 'user_changed':
                self._on_user_changed(event.get('userId'))
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
        elif operation.createdByAttempt:
            self._begin_removal(user_id, 'attempt')
            self._release(operation)
        else:
            self._release(operation)

    def _on_user_changed(self, user_id):
        if user_id in self.pending_removals:
            try:
                present = user_id in self.native.list_users()
            except Exception:  # noqa: BLE001
                present = True
            if not present:
                item = self.pending_removals.pop(user_id)
                if item['reason'] == 'remove':
                    self.committed.pop(user_id, None)
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
            if operation.createdByAttempt:
                self._begin_removal(operation.userId, 'attempt')
            self._release(operation)
            return
        if user['state'] != CONNECTED:
            return
        if user['splitMode']:
            operation.state = 'connected'
            operation.errorCode = None
            self._release(operation)
            return
        if not getattr(operation, 'split_requested', False):
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

    def _fail(self, operation, code):
        self._end(operation, 'failed', code)

    def _stop_attempt(self, operation, state, code=None):
        """Change public state; the slot stays until a terminal event or recovery."""
        login_finished = operation.state == 'checking'
        self._end(operation, state, code)
        if login_finished:
            if operation.createdByAttempt:
                self._begin_removal(operation.userId, 'attempt')
            self._release(operation)
            return
        try:
            self.native.abort(operation.email)
        except Exception as error:  # noqa: BLE001
            _log('native_abort_failed ' + type(error).__name__)

    def _release(self, operation):
        if self.slot == operation.id:
            self.slot = None

    def _begin_removal(self, user_id, reason):
        self.pending_removals[user_id] = {'reason': reason, 'since': self.clock()}
        try:
            self.native.remove_user(user_id)
        except Exception as error:  # noqa: BLE001
            _log('native_remove_failed ' + type(error).__name__)

    def _retry_removal(self, user_id):
        item = self.pending_removals[user_id]
        try:
            present = user_id in self.native.list_users()
        except Exception:  # noqa: BLE001
            return
        if not present:
            self.pending_removals.pop(user_id)
            if item['reason'] == 'remove':
                self.committed.pop(user_id, None)
            return
        self._begin_removal(user_id, item['reason'])
