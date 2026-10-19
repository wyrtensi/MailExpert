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

// The directives to add to a document's CSP, after a directive ending in ';'.
export const remoteLoadsCsp = (blocked) => (blocked ? ` ${BLOCKED_REMOTE_LOADS}` : '');

// The email frame (the open letter and each letter of a conversation): no scripts, plugins, frames
// or form posts, inline styles allowed, and remote loads forbidden when the body was served blocked.
export const emailFrameCsp = (remoteBlocked) =>
  `script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';${remoteLoadsCsp(remoteBlocked)}`;

// The print window is same-origin with no sandbox: scripts are always forbidden, and a body served
// blocked prints without its remote images.
export const printWindowCsp = (remoteBlocked) =>
  `script-src 'none'; object-src 'none'; base-uri 'none';${remoteLoadsCsp(remoteBlocked)}`;
