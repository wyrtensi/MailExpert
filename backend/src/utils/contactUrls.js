// Websites stored on a contact: [{ value, type }]. A bare "example.com" gains https://, and only
// http(s) addresses with a host are kept, so a stored value is always safe to open as a link.
export const CONTACT_URL_TYPES = ['work', 'home', 'other'];
const MAX_URLS = 20;
const MAX_URL_LENGTH = 2048;

export class ContactUrlError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export function normalizeContactUrls(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ContactUrlError('urls must be an array');
  const urls = [];
  for (const entry of list) {
    const raw = typeof entry?.value === 'string' ? entry.value.trim() : '';
    if (!raw) continue;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
    let parsed;
    try { parsed = new URL(withScheme); } catch { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
        || withScheme.length > MAX_URL_LENGTH) {
      throw new ContactUrlError(`Website "${raw.slice(0, 80)}" is not a valid http or https address`);
    }
    const type = CONTACT_URL_TYPES.includes(entry.type) ? entry.type : 'work';
    urls.push({ value: withScheme, type });
  }
  if (urls.length > MAX_URLS) throw new ContactUrlError(`A contact can have at most ${MAX_URLS} websites`);
  return urls;
}
