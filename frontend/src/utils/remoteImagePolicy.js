// Remote images blocked, enforced by the browser too.
//
// Remote images are shown by default; the user can turn blocking on. When a body is served with
// remote images blocked (the body route's remoteImagesBlocked), the backend has already rewritten
// every remote image reference it recognizes (emailSanitizer.js blockRemoteImages). The document
// the body is shown in also forbids remote images, fonts and media in its Content-Security-Policy,
// so a reference no pattern recognized (a CSS escape, a syntax not foreseen) still loads nothing:
// no tracking pixel fires. Inline images arrive as data: URIs and still show. 'self' is the panel
// itself (a srcdoc frame inherits its origin), which tells a sender nothing, and keeps working an
// inline part served from the panel rather than as a data: URI.
export const BLOCKED_REMOTE_LOADS = "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:;";

// Firefox needs the panel origin named explicitly inside srcdoc frames.
export function proxiedRemoteLoads(origin) {
  let own = '';
  try {
    const url = new URL(origin);
    if (['https:', 'http:'].includes(url.protocol) && url.origin === origin) own = ` ${origin}`;
  } catch { /* no usable browser origin */ }
  return `img-src 'self'${own} data: blob:; font-src 'self' data:; media-src 'self' data: blob:;`;
}

export const remoteLoadsCsp = (blocked, proxied = false, origin = globalThis.window?.location?.origin) =>
  blocked ? ` ${BLOCKED_REMOTE_LOADS}` : proxied ? ` ${proxiedRemoteLoads(origin)}` : '';

export const emailFrameCsp = (remoteBlocked, proxied = false) =>
  `script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';${remoteLoadsCsp(remoteBlocked, proxied)}`;

export const printWindowCsp = (remoteBlocked, proxied = false) =>
  `script-src 'none'; object-src 'none'; base-uri 'none';${remoteLoadsCsp(remoteBlocked, proxied)}`;
