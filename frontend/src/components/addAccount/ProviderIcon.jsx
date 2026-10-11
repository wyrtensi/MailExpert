// One bundled SVG per provider tile. Decorative (aria-hidden): the name beside it is the label.
// Drawn here, not fetched, so nothing is requested from a third-party site and no SVG markup is
// injected from a string. Neutral strokes use currentColor; the brand accents are fixed colours
// chosen to read on both the light and the dark theme.
const SIZE = 28;

const wrap = (children, size) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none">
    {children}
  </svg>
);

const ICONS = {
  // The panel's own mailbox on the mail node: a mailbox flag over a node dot.
  domain: (
    <>
      <rect x="4" y="8" width="24" height="17" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M5 10l11 8 11-8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25" cy="24" r="4" fill="#6366f1" />
    </>
  ),
  gmail: (
    <>
      <rect x="4" y="7" width="24" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
      <path d="M5 9l11 9 11-9" stroke="#ea4335" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 24V10M27 24V10" stroke="#4285f4" strokeWidth="2.6" strokeLinecap="round" />
    </>
  ),
  // A shield with a folded envelope line.
  proton: (
    <>
      <path d="M16 4l10 4v8c0 6-4.2 10.2-10 12-5.8-1.8-10-6-10-12V8l10-4z" fill="#6d4aff" />
      <path d="M10.5 13.5l5.5 4.5 5.5-4.5" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  yahoo: (
    <>
      <rect x="3" y="3" width="26" height="26" rx="7" fill="#7b1fe0" />
      <path d="M9 10l5 7v6M19 10l-5 7M21.5 18v-6" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21.5" cy="22.5" r="1.4" fill="#ffffff" />
    </>
  ),
  yandex: (
    <>
      <circle cx="16" cy="16" r="13" fill="#fc3f1d" />
      <path d="M17.4 8.5h-2.2c-2.4 0-3.8 1.3-3.8 3.4 0 1.6.7 2.6 2.1 3.5l1.9 1.2-2.5 5.4h2.4l2.7-6.2-1.7-1.1c-.9-.6-1.4-1-1.4-1.8 0-.9.6-1.5 1.4-1.5h.1V23h2.1V8.5z" fill="#ffffff" />
    </>
  ),
  mailru: (
    <>
      <circle cx="16" cy="16" r="13" fill="#168de2" />
      <circle cx="16" cy="16" r="4.2" stroke="#ffffff" strokeWidth="2.2" />
      <path d="M20.2 16v1.6a2.6 2.6 0 005.2 0V16a9.4 9.4 0 10-3.7 7.5" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" />
    </>
  ),
  icloud: (
    <path
      d="M9.5 24a5.5 5.5 0 01-.6-10.97A7.5 7.5 0 0123.3 11.4 6.3 6.3 0 0123 24H9.5z"
      fill="#3b9bf5"
    />
  ),
  // Manual IMAP/SMTP: a server with two status lights.
  other: (
    <>
      <rect x="5" y="6" width="22" height="8" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="5" y="18" width="22" height="8" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="22" r="1.4" fill="currentColor" />
      <path d="M16 10h7M16 22h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
};

export default function ProviderIcon({ kind, size = SIZE }) {
  return wrap(ICONS[kind] ?? ICONS.other, size);
}
