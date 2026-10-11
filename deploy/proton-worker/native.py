"""Adapter for the native Proton Bridge gRPC frontend.

The worker launches the pinned Bridge binary with `--grpc --no-window`, reads the
per-start certificate/token from the private settings directory and talks TLS over the
private UNIX socket Bridge creates in its TMPDIR. The adapter owns the single event
stream and turns native events into small dicts for the controller. Native stdout/stderr
never reach the container log.
"""

import base64
import hashlib
import json
import os
import shutil
import ssl
import stat
import subprocess
import tempfile
import threading
import time
from pathlib import Path

BRIDGE_BINARY = '/opt/proton-bridge/bridge'
IMAP_PORT = 1993
SMTP_PORT = 1465
TLS_SERVERNAME = '127.0.0.1'
CONFIG_NAME = 'grpcServerConfig.json'
RPC_TIMEOUT = 15
START_TIMEOUT = 60
STOP_TIMEOUT = 20

VERIFICATION_EVENTS = {'hvRequested', 'fidoRequested', 'loginFidoTouchRequested', 'loginFidoPinRequired'}
ERROR_CODES = {
    'USERNAME_PASSWORD_ERROR': 'bad_password',
    'FREE_USER': 'free_user',
    'CONNECTION_ERROR': 'connection',
    'TFA_ERROR': 'tfa_error',
    'TFA_ABORT': 'tfa_abort',
    'TWO_PASSWORDS_ERROR': 'two_passwords_error',
    'TWO_PASSWORDS_ABORT': 'two_passwords_abort',
    'HV_ERROR': 'verification',
    'FIDO_PIN_INVALID': 'verification',
    'FIDO_PIN_BLOCKED': 'verification',
    'FIDO_ERROR': 'verification',
}


class NativeError(RuntimeError):
    """Native Bridge failure carrying only a safe operational code."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def encode_secret(secret):
    """Bridge base64-decodes LoginRequest.password, so send base64(UTF-8(secret))."""
    return base64.b64encode(secret.encode('utf-8'))


def decode_bridge_password(value):
    """User.password carries the printable BridgePass itself; decode UTF-8 once."""
    return bytes(value).decode('utf-8')


def _private_dir(path):
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        os.chmod(path, 0o700)
        info = path.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise NativeError('private_dir')
    return path


def _bindings():
    import grpc
    import bridge_pb2
    import bridge_pb2_grpc
    from google.protobuf import empty_pb2, wrappers_pb2
    return grpc, bridge_pb2, bridge_pb2_grpc, empty_pb2, wrappers_pb2


class NativeBridge:
    """Owns one native Bridge process, its gRPC channel and its single event stream."""

    def __init__(self, state_dir, runtime_dir, binary=BRIDGE_BINARY):
        self.state_dir = Path(state_dir)
        self.runtime_dir = Path(runtime_dir)
        self.binary = binary
        self.process = None
        self.channel = None
        self.stub = None
        self.token = None
        self.callback = None
        self.stream_call = None
        self.stream_thread = None
        self.epoch = 0
        self.lock = threading.RLock()

    # -- paths -------------------------------------------------------------------------
    @property
    def config_path(self):
        return self.state_dir / 'config' / 'protonmail' / 'bridge-v3' / CONFIG_NAME

    @property
    def socket_dir(self):
        return self.runtime_dir / 'grpc'

    def environment(self):
        state = self.state_dir
        return {
            'PATH': '/usr/local/bin:/usr/bin:/bin',
            'HOME': str(state),
            'XDG_CONFIG_HOME': str(state / 'config'),
            'XDG_DATA_HOME': str(state / 'data'),
            'XDG_CACHE_HOME': str(state / 'cache'),
            'GNUPGHOME': str(state / 'gnupg'),
            'PASSWORD_STORE_DIR': str(state / 'password-store'),
            'TMPDIR': str(self.socket_dir),
            'LANG': 'C.UTF-8',
        }

    def metadata(self):
        return (('server-token', self.token),)

    # -- lifecycle ---------------------------------------------------------------------
    def start(self, callback):
        with self.lock:
            self.callback = callback
            if self.process is not None and self.process.poll() is None:
                return
            if self.process is not None:
                # The previous process died: drop its channel and stream first.
                self.process.wait(timeout=STOP_TIMEOUT)
                self._forget()
            self._launch()

    def command(self):
        # Error level keeps Info records such as HV request details (hvURL/hvToken) out of
        # the log files; the logs directory itself lives on the per-container tmpfs.
        return [self.binary, '--grpc', '--no-window', '--log-level', 'error']

    def prepare_logs(self):
        """Point Bridge's logs directory (XDG_DATA_HOME/.../logs) at the runtime tmpfs.

        Gluon data shares XDG_DATA_HOME and must persist, so only the logs directory is
        redirected with a symlink; any old persistent logs are deleted.
        """
        target = _private_dir(self.runtime_dir / 'logs')
        logs = self.state_dir / 'data' / 'protonmail' / 'bridge-v3' / 'logs'
        if logs.is_symlink() and os.path.realpath(logs) == os.path.realpath(target):
            return
        for parent in (self.state_dir, self.state_dir / 'data', logs.parent.parent, logs.parent):
            _private_dir(parent)
        if logs.is_symlink() or logs.is_file():
            logs.unlink()
        elif logs.exists():
            shutil.rmtree(logs)
        os.symlink(target, logs)

    def _launch(self):
        _private_dir(self.state_dir)
        for name in ('config', 'data', 'cache'):
            _private_dir(self.state_dir / name)
        socket_dir = _private_dir(self.socket_dir)
        try:
            self.config_path.unlink()
        except FileNotFoundError:
            pass
        self.prepare_logs()
        self.process = subprocess.Popen(
            self.command(),
            env=self.environment(), cwd=str(self.state_dir), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
        try:
            self._connect(socket_dir)
        except BaseException:
            self.epoch += 1
            self.process.kill()
            self.process.wait(timeout=STOP_TIMEOUT)
            self._forget()
            raise

    def _connect(self, socket_dir):
        grpc, pb, pb_grpc, empty, _ = _bindings()
        config = self._read_config()
        socket_path = Path(os.path.realpath(config['fileSocketPath']))
        if socket_path.parent != Path(os.path.realpath(socket_dir)) or not socket_path.is_socket():
            raise NativeError('native_socket')
        if config.get('port'):
            raise NativeError('native_socket')
        credentials = grpc.ssl_channel_credentials(root_certificates=config['cert'].encode('ascii'))
        self.channel = grpc.secure_channel(
            'unix:' + str(socket_path), credentials,
            options=[('grpc.ssl_target_name_override', TLS_SERVERNAME),
                     ('grpc.default_authority', TLS_SERVERNAME)])
        self.token = config['token']
        self.stub = pb_grpc.BridgeStub(self.channel)
        self.epoch += 1
        epoch = self.epoch
        self.stream_call = self.stub.RunEventStream(
            pb.EventStreamRequest(ClientPlatform='linux'), metadata=self.metadata())
        self.stream_thread = threading.Thread(
            target=self._pump, args=(self.stream_call, epoch), daemon=True,
            name='bridge-events')
        self.stream_thread.start()
        self.stub.GuiReady(empty.Empty(), metadata=self.metadata(), timeout=RPC_TIMEOUT)
        self._configure()

    def _read_config(self):
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise NativeError('native_exited')
            try:
                config = json.loads(self.config_path.read_text())
                if config.get('cert') and config.get('token') and config.get('fileSocketPath') \
                        and Path(config['fileSocketPath']).exists():
                    info = self.config_path.stat()
                    if stat.S_IMODE(info.st_mode) & 0o077:
                        raise NativeError('native_config_mode')
                    return config
            except (FileNotFoundError, ValueError):
                pass
            time.sleep(0.1)
        raise NativeError('native_start_timeout')

    def _configure(self):
        _, pb, _, empty, wrappers = _bindings()
        meta = self.metadata()
        wanted = pb.ImapSmtpSettings(imapPort=IMAP_PORT, smtpPort=SMTP_PORT,
                                     useSSLForImap=True, useSSLForSmtp=True)
        current = self.stub.MailServerSettings(empty.Empty(), metadata=meta, timeout=RPC_TIMEOUT)
        if current != wanted:
            self.stub.SetMailServerSettings(wanted, metadata=meta, timeout=RPC_TIMEOUT)
        self._wait(lambda: self.stub.MailServerSettings(
            empty.Empty(), metadata=meta, timeout=RPC_TIMEOUT) == wanted, 'mail_settings')
        self.stub.SetIsAutomaticUpdateOn(wrappers.BoolValue(value=False), metadata=meta, timeout=RPC_TIMEOUT)
        self._wait(lambda: not self.stub.IsAutomaticUpdateOn(
            empty.Empty(), metadata=meta, timeout=RPC_TIMEOUT).value, 'auto_update')
        self.stub.SetIsTelemetryDisabled(wrappers.BoolValue(value=True), metadata=meta, timeout=RPC_TIMEOUT)

    @staticmethod
    def _wait(check, code, timeout=RPC_TIMEOUT):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if check():
                return
            time.sleep(0.2)
        raise NativeError(code)

    def _pump(self, call, epoch):
        try:
            for event in call:
                if epoch != self.epoch:
                    return
                mapped = map_event(event)
                if mapped is not None and self.callback is not None:
                    try:
                        self.callback(mapped)
                    except Exception as error:  # noqa: BLE001 - never kill the stream
                        _log('event_handler_failed', type(error).__name__)
        except Exception:  # noqa: BLE001 - stream ends on StopEventStream/cancel/exit
            pass
        # An end we did not request (shutdown/recover bump the epoch first) means Bridge
        # lost its stream and will quit; tell the controller.
        if epoch == self.epoch and self.callback is not None:
            try:
                self.callback({'kind': 'stream_ended'})
            except Exception as error:  # noqa: BLE001
                _log('event_handler_failed', type(error).__name__)

    def shutdown(self):
        """StopEventStream, wait for the stream to end, then Quit and wait for exit."""
        with self.lock:
            if self.process is None:
                return
            self.epoch += 1
            if self.stub is not None:
                from google.protobuf import empty_pb2
                request = empty_pb2.Empty()
                try:
                    self.stub.StopEventStream(request, metadata=self.metadata(), timeout=RPC_TIMEOUT)
                except Exception:  # noqa: BLE001
                    pass
                if self.stream_thread is not None:
                    self.stream_thread.join(STOP_TIMEOUT)
                try:
                    self.stub.Quit(request, metadata=self.metadata(), timeout=RPC_TIMEOUT)
                except Exception:  # noqa: BLE001
                    pass
            self._wait_exit()

    def _wait_exit(self):
        process = self.process
        try:
            process.wait(timeout=STOP_TIMEOUT)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=STOP_TIMEOUT)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=STOP_TIMEOUT)
        self._forget()

    def _forget(self):
        self.epoch += 1
        if self.stream_call is not None:
            try:
                self.stream_call.cancel()
            except Exception:  # noqa: BLE001
                pass
        if self.channel is not None:
            self.channel.close()
        self.process = None
        self.channel = None
        self.stub = None
        self.token = None
        self.stream_call = None
        self.stream_thread = None

    def recover(self, callback):
        """Controlled restart of a stuck native process; does not wait for its callback."""
        with self.lock:
            if self.process is not None:
                self.epoch += 1
                self.process.terminate()
                try:
                    self.process.wait(timeout=STOP_TIMEOUT)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=STOP_TIMEOUT)
                self._forget()
            self.callback = callback
            self._launch()

    def running(self):
        return self.process is not None and self.process.poll() is None

    # -- RPCs --------------------------------------------------------------------------
    def _call(self, name, request):
        if self.stub is None:
            raise NativeError('native_unavailable')
        return getattr(self.stub, name)(request, metadata=self.metadata(), timeout=RPC_TIMEOUT)

    def login(self, email, password):
        _, pb, _, _, _ = _bindings()
        self._call('Login', pb.LoginRequest(username=email, password=encode_secret(password)))

    def continue_login(self, email, challenge, secret):
        _, pb, _, _, _ = _bindings()
        method = {'2fa': 'Login2FA', 'second_password': 'Login2Passwords'}[challenge]
        self._call(method, pb.LoginRequest(username=email, password=encode_secret(secret)))

    def abort(self, email):
        _, pb, _, _, _ = _bindings()
        self._call('LoginAbort', pb.LoginAbortRequest(username=email))

    def list_users(self):
        _, _, _, empty, _ = _bindings()
        return [user.id for user in self._call('GetUserList', empty.Empty()).users]

    def get_user(self, user_id):
        _, _, _, _, wrappers = _bindings()
        user = self._call('GetUser', wrappers.StringValue(value=user_id))
        return {'id': user.id, 'addresses': list(user.addresses), 'state': int(user.state),
                'splitMode': bool(user.splitMode)}

    def set_split(self, user_id):
        _, pb, _, _, _ = _bindings()
        self._call('SetUserSplitMode', pb.UserSplitModeRequest(userID=user_id, active=True))

    def remove_user(self, user_id):
        _, _, _, _, wrappers = _bindings()
        self._call('RemoveUser', wrappers.StringValue(value=user_id))

    def credentials(self, user_id, email):
        _, _, _, _, wrappers = _bindings()
        user = self._call('GetUser', wrappers.StringValue(value=user_id))
        if user.id != user_id or email.lower() not in [a.lower() for a in user.addresses]:
            raise NativeError('address_mismatch')
        certificate = self.export_certificate()
        return {'userId': user_id, 'email': email,
                'bridgePassword': decode_bridge_password(user.password),
                'certificatePem': certificate,
                'certificateFingerprint': certificate_fingerprint(certificate),
                'tlsServername': TLS_SERVERNAME}

    def export_certificate(self, timeout=RPC_TIMEOUT):
        """Export the IMAP/SMTP certificate pair privately and return only the cert PEM."""
        _, _, _, _, wrappers = _bindings()
        directory = Path(tempfile.mkdtemp(prefix='export-', dir=str(_private_dir(self.runtime_dir))))
        try:
            self._call('ExportTLSCertificates', wrappers.StringValue(value=str(directory)))
            cert_path, key_path = directory / 'cert.pem', directory / 'key.pem'
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    cert = cert_path.read_text()
                    key = key_path.read_text()
                    if cert.rstrip().endswith('-----END CERTIFICATE-----') and \
                            key.rstrip().endswith('PRIVATE KEY-----'):
                        ssl.PEM_cert_to_DER_cert(cert.strip())
                        return cert
                except (FileNotFoundError, ValueError):
                    pass
                time.sleep(0.1)
            raise NativeError('certificate_export')
        finally:
            shutil.rmtree(directory, ignore_errors=True)


def certificate_fingerprint(pem):
    return hashlib.sha256(ssl.PEM_cert_to_DER_cert(pem.strip())).hexdigest()


def map_event(event):
    """Translate a native StreamEvent to a controller event; drop everything else."""
    kind = event.WhichOneof('event')
    if kind == 'login':
        login = event.login
        name = login.WhichOneof('event')
        if name == 'error':
            _, pb, _, _, _ = _bindings()
            label = pb.LoginErrorType.Name(login.error.type)
            return {'kind': 'error', 'code': ERROR_CODES.get(label, 'unknown')}
        if name in ('tfaRequested', 'tfaOrFidoRequested'):
            return {'kind': 'needs_2fa'}
        if name == 'twoPasswordRequested':
            return {'kind': 'needs_second_password'}
        if name == 'finished':
            return {'kind': 'finished', 'userId': login.finished.userID}
        if name == 'alreadyLoggedIn':
            return {'kind': 'already_logged_in', 'userId': login.alreadyLoggedIn.userID}
        if name in VERIFICATION_EVENTS:
            return {'kind': 'hv'}
        return None
    if kind == 'user':
        name = event.user.WhichOneof('event')
        if name == 'userChanged':
            return {'kind': 'user_changed', 'userId': event.user.userChanged.userID}
        if name == 'toggleSplitModeFinished':
            return {'kind': 'user_changed', 'userId': event.user.toggleSplitModeFinished.userID}
        return None
    if kind == 'keychain' and event.keychain.WhichOneof('event') == 'hasNoKeychain':
        return {'kind': 'no_keychain'}
    return None


def _log(code, detail=''):
    os.write(2, ('proton-worker: %s %s\n' % (code, detail)).encode('ascii', 'replace'))
