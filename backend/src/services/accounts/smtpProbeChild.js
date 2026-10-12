import nodemailer from 'nodemailer';
import { connectionError } from './connectionErrors.js';

process.once('message', async ({ endpoint, auth, timeoutMs }) => {
  let transport;
  let response;
  try {
    transport = nodemailer.createTransport({
      host: endpoint.host, port: endpoint.port, secure: endpoint.secure, requireTLS: endpoint.requireTLS,
      name: 'localhost', auth, forceAuth: true,
      tls: { ...endpoint.tls, ...(endpoint.servername ? { servername: endpoint.servername } : {}), rejectUnauthorized: true },
      logger: false, debug: false,
      connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs,
    });
    await transport.verify();
    response = { ok: true };
  } catch (error) { response = { code: connectionError(error, 'smtp').code }; }
  finally { transport?.close(); }
  process.send?.(response);
});

process.on('disconnect', () => process.exit(0));
