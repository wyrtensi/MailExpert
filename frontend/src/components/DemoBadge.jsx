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
      // Bottom centre, click-through: the corners hold the compose window's buttons and the user menu.
      position: 'fixed',
      left: '50%',
      bottom: 12,
      transform: 'translateX(-50%)',
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
