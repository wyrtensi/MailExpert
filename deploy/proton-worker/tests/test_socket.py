import http.client
import json
import os
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path

try:
    from worker import create_server
except ImportError:
    create_server = None


class SocketTests(unittest.TestCase):
    def test_socket_is_private_and_no_tcp_listener(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        class Controller:
            def health(self):
                return {'state': 'idle'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(server.socket.family, socket.AF_UNIX)
                self.assertEqual(stat.S_IMODE(pathname.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(Path(directory).stat().st_mode), 0o700)
                client = socket.socket(socket.AF_UNIX)
                client.connect(str(pathname))
                connection = http.client.HTTPConnection('localhost')
                connection.sock = client
                connection.request('GET', '/healthz')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {'state': 'idle'})
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_errors_are_mapped_without_details(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        from controller import WorkerError

        class Controller:
            def health(self):
                raise RuntimeError('secret-sentinel')

            def connection_status(self, operation_id):
                raise WorkerError('not_found')

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def call(method, path, body=None):
                    client = socket.socket(socket.AF_UNIX)
                    client.connect(str(pathname))
                    connection = http.client.HTTPConnection('localhost')
                    connection.sock = client
                    connection.request(method, path, body=body)
                    response = connection.getresponse()
                    result = response.status, response.read().decode()
                    connection.close()
                    return result

                status, text = call('GET', '/healthz')
                self.assertEqual((status, json.loads(text)), (500, {'errorCode': 'worker_unavailable'}))
                self.assertEqual(call('GET', '/connections/attempt-a')[0], 404)
                self.assertEqual(call('GET', '/connections/../etc')[0], 404)
                self.assertEqual(call('POST', '/connections', b'x' * 70000)[0], 400)
                self.assertEqual(call('POST', '/connections', b'[1]')[0], 400)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_percent_encoded_padded_user_id_is_decoded_before_validation(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        padded = 'aB3-x_Yz9Qw8LmNo+pQrStUvWxYz0123456789AbCd=='
        seen = []

        class Controller:
            def credentials(self, user_id, operation_id=None, generation=None, email=None):
                seen.append(user_id)
                return {'userId': user_id}

            def remove_user(self, user_id, generation, email):
                seen.append(user_id)
                return {'state': 'removing'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def call(path):
                    client = socket.socket(socket.AF_UNIX)
                    client.connect(str(pathname))
                    connection = http.client.HTTPConnection('localhost')
                    connection.sock = client
                    connection.request('POST', path, body=b'{"operationId":"attempt-a"}',
                                       headers={'Content-Type': 'application/json'})
                    response = connection.getresponse()
                    result = response.status, json.loads(response.read())
                    connection.close()
                    return result

                encoded = padded.replace('+', '%2B').replace('=', '%3D')
                self.assertEqual(call('/users/%s/credentials' % encoded), (200, {'userId': padded}))
                self.assertEqual(call('/users/%s/remove' % encoded)[0], 200)
                self.assertEqual(seen, [padded, padded])
                for unsafe in ['a%2Fb', 'a%2Eb', 'a%253D', 'a%3Db', 'a%ZZ', 'a%C3%A9', 'x' * 129]:
                    status, payload = call('/users/%s/credentials' % unsafe)
                    self.assertIn(status, (400, 404), unsafe)
                    if status == 400:
                        self.assertEqual(payload, {'errorCode': 'worker_invalid_request'})
                self.assertEqual(seen, [padded, padded])
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_degraded_health_is_not_200(self):
        # I-2: a Bridge that should run but does not makes the Docker healthcheck fail.
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')

        class Controller:
            def health(self):
                return {'state': 'degraded'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = socket.socket(socket.AF_UNIX)
                client.connect(str(pathname))
                connection = http.client.HTTPConnection('localhost')
                connection.sock = client
                connection.request('GET', '/healthz')
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(json.loads(response.read()), {'state': 'degraded'})
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
