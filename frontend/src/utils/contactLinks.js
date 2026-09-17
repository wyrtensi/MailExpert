// Links between contacts, messages and the composer.

// A website is opened only as an http(s) address; anything else renders as plain text.
export function websiteHref(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

// "https://www.example.com/" reads as "www.example.com".
export function websiteLabel(value) {
  return String(value || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

// The recipient the composer gets for a contact: "Name <address>", or the bare address.
export function contactComposeAddress(contact) {
  const email = contact?.primary_email || contact?.emails?.[0]?.value || '';
  if (!email) return null;
  const name = (contact.display_name || '').replace(/[<>"\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return name && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email;
}

// The contact among search results that holds exactly this address, if any.
export function contactForEmail(contacts, email) {
  const wanted = String(email || '').trim().toLowerCase();
  if (!wanted) return null;
  return (contacts || []).find(contact => (
    contact.primary_email?.toLowerCase() === wanted
    || (contact.emails || []).some(entry => entry.value?.toLowerCase() === wanted)
  )) || null;
}

// A new contact form prefilled from a message sender.
export function contactFormFromSender({ email, name } = {}) {
  const cleanName = String(name || '').trim();
  return {
    displayName: cleanName && cleanName.toLowerCase() !== String(email || '').toLowerCase() ? cleanName : '',
    firstName: '',
    lastName: '',
    emails: [{ value: String(email || '').trim(), type: 'other', primary: true }],
    phones: [],
    urls: [],
    organization: '',
    notes: '',
  };
}
