import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function probeCertificate() {
  const directory = mkdtempSync(path.join(tmpdir(), 'mail-probe-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '2', '-subj', '/CN=mail.example.com', '-addext', 'subjectAltName=DNS:mail.example.com'], { cwd: directory, stdio: 'pipe' });
    return { key: readFileSync(path.join(directory, 'key.pem'), 'utf8'), cert: readFileSync(path.join(directory, 'cert.pem'), 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function smtpFixture({ certificate, mode = 'implicit', advertiseAuth = true, rejectAuth = false, stall = false, stallQuit = false } = {}) {
  const sockets = new Set();
  const commands = [];
  const servernames = [];
  let accepted;
  const ready = new Promise(resolve => { accepted = resolve; });
  const handle = socket => {
    socket.on('error', () => {});
    if (socket.servername) servernames.push(socket.servername);
    let buffer = '';
    const data = chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        if (/^EHLO|^HELO/i.test(line)) {
          socket.write(`250-mail.example.com\r\n${mode === 'starttls' && !socket.encrypted ? '250-STARTTLS\r\n' : ''}${advertiseAuth ? '250-AUTH PLAIN\r\n' : ''}250 SIZE 100000\r\n`);
        } else if (/^STARTTLS/i.test(line) && mode === 'starttls') {
          socket.removeListener('data', data);
          socket.write('220 Ready\r\n', () => handle(new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(certificate) })));
        } else if (/^AUTH/i.test(line)) socket.write(rejectAuth || !advertiseAuth ? '535 5.7.8 secret-sentinel\r\n' : '235 Authenticated\r\n');
        else if (/^QUIT/i.test(line) && !stallQuit) socket.end('221 Bye\r\n');
        else if (!/^QUIT/i.test(line)) socket.write('500 Unsupported\r\n');
      }
    };
    socket.on('data', data);
  };
  const connection = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    accepted();
  };
  const greeting = socket => {
    handle(socket);
    if (!stall) socket.write('220 mail.example.com ready\r\n');
  };
  const server = mode === 'implicit' ? tls.createServer(certificate, greeting) : net.createServer(greeting);
  server.on('connection', connection);
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    ready, sockets, commands, servernames,
    endpoint: { host: '127.0.0.1', port: server.address().port, addresses: ['127.0.0.1'], servername: 'mail.example.com', tls: { ca: certificate?.cert }, secure: mode === 'implicit', requireTLS: mode !== 'implicit' },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

export async function imapNoStarttlsFixture() {
  const sockets = new Set();
  const commands = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n');
    socket.on('data', chunk => {
      for (const line of chunk.toString().split('\r\n').filter(Boolean)) {
        commands.push(line);
        const [tag, command] = line.split(' ');
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n${tag} OK done\r\n`);
        else if (command === 'STARTTLS') socket.write(`${tag} BAD STARTTLS unavailable\r\n`);
        else socket.write(`${tag} BAD Unsupported\r\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    sockets, commands,
    endpoint: { host: '127.0.0.1', addresses: ['127.0.0.1'], port: server.address().port, servername: 'mail.example.com', secure: false },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}

export async function imapFixture({ certificate, mode = 'implicit', stallList = false } = {}) {
  const sockets = new Set();
  const commands = [];
  let listed;
  const listReady = new Promise(resolve => { listed = resolve; });
  const capabilities = socket => `IMAP4rev1 AUTH=PLAIN${mode === 'starttls' && !socket.encrypted ? ' STARTTLS' : ''}`;
  const handle = socket => {
    socket.on('error', () => {});
    let buffer = '';
    let authTag;
    const data = chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (authTag) { socket.write(`${authTag} OK authenticated\r\n`); authTag = null; continue; }
        commands.push(line);
        const [tag, command] = line.split(' ');
        if (command === 'CAPABILITY') socket.write(`* CAPABILITY ${capabilities(socket)}\r\n${tag} OK done\r\n`);
        else if (command === 'STARTTLS') {
          socket.removeListener('data', data);
          socket.write(`${tag} OK upgrade\r\n`, () => handle(new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(certificate) })));
        } else if (command === 'AUTHENTICATE') { authTag = tag; socket.write('+ \r\n'); }
        else if (command === 'LIST') {
          listed();
          if (!stallList) socket.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK done\r\n`);
        } else if (command === 'LOGOUT') socket.end(`* BYE\r\n${tag} OK bye\r\n`);
        else socket.write(`${tag} OK done\r\n`);
      }
    };
    socket.on('data', data);
  };
  const greeting = socket => {
    handle(socket);
    socket.write(`* OK [CAPABILITY ${capabilities(socket)}] ready\r\n`);
  };
  const server = mode === 'implicit' ? tls.createServer(certificate, greeting) : net.createServer(greeting);
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    commands, sockets, listReady,
    endpoint: { host: '127.0.0.1', port: server.address().port, addresses: ['127.0.0.1'], servername: 'mail.example.com', tls: { ca: certificate.cert }, secure: mode === 'implicit' },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }),
  };
}
