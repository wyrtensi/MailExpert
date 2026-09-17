import { createElement } from 'react';

export function demoBadgeLabel(enabled) {
  return enabled ? 'Demo mode' : '';
}

export default function DemoBadge({ enabled = false }) {
  const label = demoBadgeLabel(enabled);

  if (!label) return null;

  return createElement('div', {
    'aria-live': 'polite',
    style: {
      position: 'fixed',
      right: 16,
      bottom: 16,
      zIndex: 1100,
      padding: '6px 10px',
      border: '1px solid var(--border)',
      borderRadius: 999,
      background: 'var(--bg-secondary)',
      boxShadow: 'var(--shadow-md)',
      color: 'var(--text-secondary)',
      fontSize: 12,
      fontWeight: 600,
      pointerEvents: 'none',
    },
  }, `${label} — local data`);
}
