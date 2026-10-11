"""Private HTTP API of the managed Proton Bridge worker, served on a UNIX socket only.

Routes (JSON, bodies <= 64 KiB):
  GET  /healthz
  POST /connections                 {operationId, email, password}
  GET  /connections/:id
  POST /connections/:id/continue    {challenge: "2fa"|"second_password", secret}
  POST /connections/:id/commit      {userId, generation, previousGeneration?}
  POST /connections/:id/cancel
  POST /users/:id/credentials       {operationId} | {generation, email}
  POST /users/:id/remove            {generation, email}  (one (user, address) link)
GET /healthz answers 503 when Bridge should run (links, removals) but does not.
Request bodies and native details are never logged.
"""

import json
import os
import re
import signal
import socketserver
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path

from controller import BridgeController, WorkerError

SOCKET_PATH = '/run/mailexpert-proton/worker.sock'
STATE_DIR = '/var/lib/mailexpert-proton'
NATIVE_RUNTIME_DIR = '/run/mailexpert-proton-native'
MAX_BODY = 65536
ID = r'([A-Za-z0-9_-]{1,128})'
STATUS = {'not_found': 404, 'login_busy': 409, 'operation_conflict': 409,
          'generation_mismatch': 409, 'not_connected': 409, 'address_mismatch': 409,
          'invalid_challenge': 400, 'worker_invalid_request': 400, 'worker_unavailable': 503}


def _routes(controller):
    def operation(result):
        return result.to_dict()

    return [
        ('GET', re.compile(r'^/healthz$'), lambda body: controller.health()),
        ('POST', re.compile(r'^/connections$'), lambda body: operation(controller.start_connection(
            body.get('operationId'), body.get('email'), body.get('password')))),
        ('GET', re.compile(r'^/connections/%s$' % ID),
         lambda body, i: operation(controller.connection_status(i))),
        ('POST', re.compile(r'^/connections/%s/continue$' % ID),
         lambda body, i: operation(controller.continue_connection(
             i, body.get('challenge'), body.get('secret')))),
        ('POST', re.compile(r'^/connections/%s/commit$' % ID),
         lambda body, i: operation(controller.commit_connection(
             i, body.get('userId'), body.get('generation'),
             previous_generation=body.get('previousGeneration')))),
        ('POST', re.compile(r'^/connections/%s/cancel$' % ID),
         lambda body, i: operation(controller.cancel_connection(i))),
        ('POST', re.compile(r'^/users/%s/credentials$' % ID),
         lambda body, i: controller.credentials(
             i, operation_id=body.get('operationId'), generation=body.get('generation'),
             email=body.get('email'))),
        ('POST', re.compile(r'^/users/%s/remove$' % ID),
         lambda body, i: controller.remove_user(i, body.get('generation'), body.get('email'))),
    ]


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'mailexpert-proton'
    sys_version = ''

    def address_string(self):
        return 'unix'

    def log_message(self, *args):
        pass

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def _dispatch(self, method):
        try:
            body = self._body()
            for route_method, pattern, handler in self.server.routes:
                match = pattern.match(self.path)
                if match and route_method == method:
                    result = handler(body, *match.groups())
                    degraded = self.path == '/healthz' and result.get('state') == 'degraded'
                    self._send(503 if degraded else 200, result)
                    return
            raise WorkerError('not_found')
        except WorkerError as error:
            code = error.code if error.code in STATUS else 'worker_unavailable'
            self._send(STATUS[code], {'errorCode': code})
        except Exception as error:  # noqa: BLE001 - never echo details
            os.write(2, ('proton-worker: request_failed %s\n' % type(error).__name__).encode())
            self._send(500, {'errorCode': 'worker_unavailable'})

    def _body(self):
        length = self.headers.get('Content-Length')
        if not length:
            return {}
        if not length.isdigit() or int(length) > MAX_BODY:
            self.close_connection = True
            raise WorkerError('worker_invalid_request')
        raw = self.rfile.read(int(length))
        try:
            body = json.loads(raw.decode('utf-8')) if raw else {}
        except ValueError:
            raise WorkerError('worker_invalid_request') from None
        if not isinstance(body, dict):
            raise WorkerError('worker_invalid_request')
        return body

    def _send(self, status, payload):
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Client resets and similar transport errors: log the type only, never a traceback.
        error = sys.exc_info()[1]
        os.write(2, ('proton-worker: connection_error %s\n' % type(error).__name__).encode())

    def server_bind(self):
        directory = Path(self.server_address).parent
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(directory, 0o700)
        info = directory.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise PermissionError('socket directory is not private')
        try:
            os.unlink(self.server_address)
        except FileNotFoundError:
            pass
        previous = os.umask(0o177)
        try:
            super().server_bind()
        finally:
            os.umask(previous)
        # The socket is not listening yet: chmod before server_activate() is race-free.
        os.chmod(self.server_address, 0o600)


def create_server(controller, pathname=SOCKET_PATH):
    server = UnixHTTPServer(str(pathname), Handler)
    server.routes = _routes(controller)
    return server


def main():
    os.umask(0o077)
    from native import NativeBridge
    state_dir = Path(os.environ.get('PROTON_WORKER_STATE_DIR', STATE_DIR))
    native = NativeBridge(state_dir / 'bridge',
                          Path(os.environ.get('PROTON_WORKER_NATIVE_DIR', NATIVE_RUNTIME_DIR)))
    controller = BridgeController(native, state_dir / 'controller')
    server = create_server(controller, os.environ.get('PROTON_WORKER_SOCKET', SOCKET_PATH))
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, lambda *_: stop.set())
    serving = threading.Thread(target=server.serve_forever, name='http', daemon=True)
    serving.start()
    try:
        controller.boot()
    except WorkerError:
        os.write(2, b'proton-worker: boot_start_failed\n')

    def ticker():
        while not stop.wait(1):
            try:
                controller.tick()
            except Exception as error:  # noqa: BLE001
                os.write(2, ('proton-worker: tick_failed %s\n' % type(error).__name__).encode())

    threading.Thread(target=ticker, name='tick', daemon=True).start()
    os.write(2, b'proton-worker: ready\n')
    stop.wait()
    server.shutdown()
    server.server_close()
    controller.shutdown()
    os.write(2, b'proton-worker: stopped\n')
    return 0


def healthcheck(pathname=SOCKET_PATH):
    import http.client
    import socket
    try:
        client = socket.socket(socket.AF_UNIX)
        client.settimeout(4)
        client.connect(os.environ.get('PROTON_WORKER_SOCKET', pathname))
        connection = http.client.HTTPConnection('localhost', timeout=4)
        connection.sock = client
        connection.request('GET', '/healthz')
        status = connection.getresponse().status
        connection.close()
    except OSError:
        return 1
    return 0 if status == 200 else 1


if __name__ == '__main__':
    sys.exit(healthcheck() if sys.argv[1:] == ['--healthcheck'] else main())
