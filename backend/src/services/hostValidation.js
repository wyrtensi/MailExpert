import { BlockList, isIPv4, isIPv6 } from 'net';
import { promises as dnsPromises } from 'dns';
import { promises as fsPromises } from 'fs';
import { domainToASCII } from 'url';

function ipv4ToLong(ip) {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inCidr(ip, base, bits) {
  const mask = bits === 0 ? 0 : ((~0 << (32 - bits)) >>> 0);
  return (ipv4ToLong(ip) & mask) === (ipv4ToLong(base) & mask);
}

function isPrivateIPv4(ip) {
  return (
    inCidr(ip, '0.0.0.0', 8)      ||  // 0.x.x.x
    inCidr(ip, '10.0.0.0', 8)     ||  // private
    inCidr(ip, '100.64.0.0', 10)  ||  // CGNAT shared
    inCidr(ip, '127.0.0.0', 8)    ||  // loopback
    inCidr(ip, '169.254.0.0', 16) ||  // link-local (AWS metadata)
    inCidr(ip, '172.16.0.0', 12)  ||  // private
    inCidr(ip, '192.0.0.0', 24)   ||  // IETF protocol assignments
    inCidr(ip, '192.168.0.0', 16) ||  // private
    inCidr(ip, '198.18.0.0', 15)  ||  // benchmarking
    inCidr(ip, '240.0.0.0', 4)    ||  // reserved
    ip === '255.255.255.255'
  );
}

// IPv6 ranges that never name a public unicast host. IPv4-mapped addresses (::ffff:0:0/96)
// are not listed: they are checked as the IPv4 address they carry.
const PRIVATE_IPV6 = new BlockList();
for (const [prefix, bits] of [
  ['::', 96],          // unspecified, loopback and deprecated IPv4-compatible (::a.b.c.d)
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated
  ['64:ff9b:1::', 48], // local-use NAT64 (RFC 8215)
  ['100::', 64],       // discard-only
  ['2001::', 32],      // Teredo: tunnels through NAT and can reach private ranges
  ['fc00::', 7],       // unique local
  ['fe80::', 10],      // link-local
  ['fec0::', 10],      // deprecated site-local
  ['ff00::', 8],       // multicast
]) PRIVATE_IPV6.addSubnet(prefix, bits, 'ipv6');

// The eight 16-bit groups of a valid IPv6 address (any notation, dotted IPv4 tail included).
function ipv6Groups(ip) {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (text.includes('.')) {
    const cut = text.lastIndexOf(':') + 1;
    const v4 = text.slice(cut).split('.').map(Number);
    text = `${text.slice(0, cut)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const [head, tail = null] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === null ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return groups.map(g => parseInt(g || '0', 16));
}

function ipv4FromGroups(hi, lo) {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function isPrivateIPv6(ip) {
  const g = ipv6Groups(ip);
  // IPv4-mapped (::ffff:0:0/96, in dotted or hex form): judge the IPv4 address it carries.
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return isPrivateIPv4(ipv4FromGroups(g[6], g[7]));
  // NAT64 well-known prefix (64:ff9b::/96): a gateway forwards it to the embedded IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) {
    return isPrivateIPv4(ipv4FromGroups(g[6], g[7]));
  }
  // 6to4 (2002::/16) embeds an IPv4 address in bits 16-47.
  if (g[0] === 0x2002 && isPrivateIPv4(ipv4FromGroups(g[1], g[2]))) return true;
  return PRIVATE_IPV6.check(g.map(x => x.toString(16)).join(':'), 'ipv6');
}

// getaddrinfo (glibc, musl) reads 2130706433, 0x7f000001, 0177.0.0.1 and 127.1 as IPv4
// addresses, but net.isIPv4 accepts only the dotted quad. The URL parser reads the same
// inet_aton forms, so use it to find the address the socket would connect to.
function inetAtonIPv4(host) {
  if (!/^[0-9a-fx.]+$/.test(host)) return null;
  try {
    const { hostname } = new URL(`http://${host}/`);
    return isIPv4(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

// Synchronous check: literal IPs and reserved hostnames.
export function validateHostLiteral(host, { allowPrivate = false } = {}) {
  if (!host || typeof host !== 'string') return null;
  if (allowPrivate) return null;
  let h = host.trim();
  // dns.lookup converts a non-ASCII host to ASCII before getaddrinfo reads it, so
  // １２７.０.０.１ reaches 127.0.0.1 and ::１ reaches ::1. Check the converted form, and
  // refuse a host that domainToASCII rejects, as it does every Unicode spelling of IPv6.
  if (/[^\p{ASCII}]/u.test(h)) {
    h = domainToASCII(h);
    if (!h) return 'Host is not a valid hostname';
  }
  h = h.toLowerCase();
  // A trailing dot makes a name fully qualified, not a different one: localhost. is localhost.
  const name = h.replace(/\.+$/, '');
  if (name === 'localhost' || name.endsWith('.local') || name.endsWith('.localhost') || name.endsWith('.internal')) {
    return 'Host cannot be a local address';
  }
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  const v4 = isIPv4(bare) ? bare : inetAtonIPv4(bare);
  if (v4 && isPrivateIPv4(v4)) return 'Host cannot be a private or reserved IP address';
  if (isIPv6(bare) && isPrivateIPv6(bare)) return 'Host cannot be a private or reserved IP address';
  return null;
}

// Async check: resolve A/AAAA records and reject any that are private/reserved.
// Prevents SSRF via controlled hostnames that resolve to internal addresses.
export async function validateHost(host, { allowPrivate = false } = {}) {
  const literalErr = validateHostLiteral(host, { allowPrivate });
  if (literalErr) return literalErr;

  const h = host.trim().toLowerCase();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;

  // Already a literal IP — validated above.
  if (isIPv4(bare) || isIPv6(bare)) return null;

  // Resolve the host's addresses. Ignore resolver errors — if the host can't be resolved,
  // the IMAP/SMTP connection will fail naturally; the concern is hosts that DO resolve
  // to private ranges.
  const resolved = await resolveAddresses(bare);

  if (!allowPrivate) {
    for (const addr of resolved) {
      if (isIPv4(addr) && isPrivateIPv4(addr)) return 'Host resolves to a private or reserved IP address';
      if (isIPv6(addr) && isPrivateIPv6(addr)) return 'Host resolves to a private or reserved IP address';
    }
  }

  return null;
}

// A host's addresses: from DNS, and when DNS has none, from the system resolver. The connection
// itself resolves through the system resolver (getaddrinfo), which also reads /etc/hosts, so a name
// only that file knows (ip6-localhost in the container image, or an alias an operator added) was let
// through unchecked and then connected to loopback or a private address.
//
// getaddrinfo runs on libuv's thread pool (four threads, shared with fs and crypto), and names
// DNS does not know are easy to supply (a List-Unsubscribe host in someone's mail), so it is not
// asked about every miss. A single-label name (ip6-localhost, _gateway, a bare hostname) goes to
// the system resolver, which also answers it from sources other than files and DNS, at most
// SYSTEM_LOOKUPS_AT_ONCE at a time; a name with dots is looked up in the hosts file itself.
async function resolveAddresses(bare) {
  // Compare the same ASCII name getaddrinfo uses, including when DNS misses and
  // only the hosts file knows a Unicode spelling's normalized name.
  const canonical = /[^\p{ASCII}]/u.test(bare) ? domainToASCII(bare) : bare;
  const [v4, v6] = await Promise.all([
    dnsPromises.resolve4(canonical).catch(() => []),
    dnsPromises.resolve6(canonical).catch(() => []),
  ]);
  if (v4.length || v6.length) return [...v4, ...v6];
  const name = canonical.replace(/\.+$/, '');
  if (name.includes('.')) return hostsFileAddresses(name);
  const looked = await systemLookup(name).catch(() => []);
  return (Array.isArray(looked) ? looked : []).map(a => a.address).filter(Boolean);
}

const HOSTS_FILE = process.platform === 'win32'
  ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\drivers\\etc\\hosts`
  : '/etc/hosts';

// The addresses the hosts file gives `name` (case-insensitive, a trailing dot ignored).
async function hostsFileAddresses(name) {
  const text = await fsPromises.readFile(HOSTS_FILE, 'utf8').catch(() => '');
  const wanted = name.toLowerCase();
  const addresses = [];
  for (const line of String(text).split(/\r?\n/)) {
    const [address, ...names] = line.replace(/#.*/, '').trim().split(/\s+/);
    if (!address || !(isIPv4(address) || isIPv6(address))) continue;
    if (names.some(n => n.toLowerCase().replace(/\.+$/, '') === wanted)) addresses.push(address);
  }
  return addresses;
}

const SYSTEM_LOOKUPS_AT_ONCE = 2;
let systemLookups = 0;
const waitingLookups = [];

async function systemLookup(name) {
  if (systemLookups >= SYSTEM_LOOKUPS_AT_ONCE) await new Promise(resolve => waitingLookups.push(resolve));
  else systemLookups += 1;
  try {
    return await dnsPromises.lookup(name, { all: true, verbatim: true });
  } finally {
    // Hand the slot straight to the next waiter, or free it.
    const next = waitingLookups.shift();
    if (next) next();
    else systemLookups -= 1;
  }
}

export function createPinnedLookup(addresses) {
  const candidates = addresses.map(address => ({
    address,
    family: isIPv4(address) ? 4 : 6,
  }));

  return (_hostname, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const family = Number(options?.family) || 0;
    const eligible = family ? candidates.filter(candidate => candidate.family === family) : candidates;
    if (!eligible.length) {
      const err = new Error('No validated address matches the requested family');
      err.code = 'ENOTFOUND';
      return process.nextTick(callback, err);
    }
    // Match dns.lookup timing so TLS can attach its error listener before connection failure.
    if (options?.all) return process.nextTick(callback, null, eligible.map(candidate => ({ ...candidate })));
    process.nextTick(callback, null, eligible[0].address, eligible[0].family);
  };
}

// Resolves a hostname to public IPs for use as the only permitted connection targets,
// closing the DNS rebinding TOCTOU window between validation and the real connect.
//
// `host` remains the first IP for callers that cannot use multi-address fallback. `lookup`
// exposes the complete validated set without performing DNS again, while `servername`
// preserves the original hostname for TLS SNI and certificate verification.
//
// Throws if the host is a reserved/private literal or if DNS resolves to a private range.
// Pass { allowPrivate: true } to skip all private/local checks (for self-hosted servers).
export async function resolveForConnection(hostname, { allowPrivate = false } = {}) {
  const literalErr = validateHostLiteral(hostname, { allowPrivate });
  if (literalErr) throw new Error(literalErr);

  const h = hostname.trim();
  const bare = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h.toLowerCase();

  // Already a literal IP — validated above, no DNS resolution needed.
  if (isIPv4(bare) || isIPv6(bare)) return { host: h, servername: null };

  const resolved = await resolveAddresses(bare);

  if (!allowPrivate) {
    for (const addr of resolved) {
      if (isIPv4(addr) && isPrivateIPv4(addr)) throw new Error('Host resolves to a private or reserved IP address');
      if (isIPv6(addr) && isPrivateIPv6(addr)) throw new Error('Host resolves to a private or reserved IP address');
    }
  }

  const all = [...new Set(resolved)];
  // No resolver knows the name — let the connection attempt fail naturally (NXDOMAIN etc.).
  if (!all.length) return { host: h, servername: null };

  // Expose only prevalidated addresses to the connection layer. No later DNS query can
  // substitute an unvalidated target, and TLS still authenticates the original hostname.
  return {
    host: all[0],
    servername: h,
    addresses: all,
    lookup: createPinnedLookup(all),
  };
}
