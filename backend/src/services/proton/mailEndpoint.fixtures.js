import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A self-signed certificate shaped like the one Bridge generates for its IMAP/SMTP listeners:
// CN and IP SAN 127.0.0.1, no DNS name. `san` lets a test build one for another identity.
export function loopbackCertificate({ cn = '127.0.0.1', san = 'IP:127.0.0.1' } = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), 'proton-endpoint-cert-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.pem',
      '-days', '2', '-subj', `/CN=${cn}`, '-addext', `subjectAltName=${san}`], { cwd: directory, stdio: 'pipe' });
    return { key: readFileSync(path.join(directory, 'key.pem'), 'utf8'), cert: readFileSync(path.join(directory, 'cert.pem'), 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// The worker's fingerprint format: lowercase hex SHA-256 of the DER certificate.
export function workerFingerprint(pem) {
  return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
}
