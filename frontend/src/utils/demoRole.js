// Demo mode only: whom the demo signs in as. The owner looks at what an ordinary (non-admin)
// user sees without a server, so the demo can play either role. `?demoUser=user` or
// `?demoUser=admin` in the address sets it; the choice is remembered in this browser. Storage
// can throw (private windows, blocked site data), so every access is guarded and the default is
// the administrator, as before.

export const DEMO_ROLE_KEY = 'mailexpert_demo_role';
const ROLES = new Set(['admin', 'user']);

export function demoRole({ search = globalThis.location?.search ?? '', storage = globalThis.localStorage } = {}) {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(search).get('demoUser'); } catch { /* no URL */ }
  if (ROLES.has(fromUrl)) {
    try { storage?.setItem(DEMO_ROLE_KEY, fromUrl); } catch { /* storage unavailable */ }
    return fromUrl;
  }
  try {
    const saved = storage?.getItem(DEMO_ROLE_KEY);
    if (ROLES.has(saved)) return saved;
  } catch { /* storage unavailable */ }
  return 'admin';
}

// Switch the demo to the other role and reload, so every screen starts from that user.
export function switchDemoRole(current, { storage = globalThis.localStorage, location = globalThis.location } = {}) {
  const next = current === 'user' ? 'admin' : 'user';
  try { storage?.setItem(DEMO_ROLE_KEY, next); } catch { /* storage unavailable */ }
  if (location) {
    const url = new URL(location.href);
    url.searchParams.delete('demoUser');
    location.assign(url.toString());
  }
  return next;
}

// Demo mode only: whether the demo plays a panel with deleting letters turned off
// (MAIL_DELETE_ENABLED=false). `?demoDelete=off` or `?demoDelete=on` sets it, remembered in this
// browser; on by default.
export const DEMO_DELETE_KEY = 'mailexpert_demo_delete';
const DELETE_SWITCH = new Set(['on', 'off']);

export function demoDeleteEnabled({ search = globalThis.location?.search ?? '', storage = globalThis.localStorage } = {}) {
  let fromUrl = null;
  try { fromUrl = new URLSearchParams(search).get('demoDelete'); } catch { /* no URL */ }
  if (DELETE_SWITCH.has(fromUrl)) {
    try { storage?.setItem(DEMO_DELETE_KEY, fromUrl); } catch { /* storage unavailable */ }
    return fromUrl === 'on';
  }
  try {
    if (storage?.getItem(DEMO_DELETE_KEY) === 'off') return false;
  } catch { /* storage unavailable */ }
  return true;
}
