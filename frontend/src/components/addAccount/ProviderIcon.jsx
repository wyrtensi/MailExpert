// Official brand assets are bundled locally. See public/provider-icons/README.md for provenance.
// Decorative images do not repeat the provider name already present beside them.
const ASSETS = Object.freeze({
  domain: '/favicon.svg',
  gmail: '/provider-icons/gmail.svg',
  proton: '/provider-icons/proton.svg',
  yahoo: '/provider-icons/yahoo.jpg',
  yandex: '/provider-icons/yandex.jpg',
  mailru: '/provider-icons/mailru.png',
  icloud: '/provider-icons/icloud.png',
});

export default function ProviderIcon({ kind, size = 28 }) {
  if (ASSETS[kind]) {
    return <img className="add-account-provider-image" src={ASSETS[kind]} width={size} height={size} alt="" aria-hidden="true" draggable={false} />;
  }
  // "Other" describes a server, not a brand.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false" fill="none">
      <rect x="5" y="6" width="22" height="8" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <rect x="5" y="18" width="22" height="8" rx="2.5" stroke="currentColor" strokeWidth="2" />
      <circle cx="10" cy="10" r="1.4" fill="currentColor" />
      <circle cx="10" cy="22" r="1.4" fill="currentColor" />
      <path d="M16 10h7M16 22h7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
