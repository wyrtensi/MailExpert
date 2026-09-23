import { createElement } from 'react';

export function demoBadgeLabel(enabled) {
  return enabled ? 'Demo mode' : '';
}

// `switchLabel` and `onSwitch` add a button that signs the demo in as the other role (admin or
// ordinary user); the badge itself stays click-through, only the button takes clicks.
const narrowScreen = () => typeof window !== 'undefined' && !!window.matchMedia?.('(max-width: 767px)').matches;

export default function DemoBadge({ enabled = false, roleLabel = '', switchLabel = '', onSwitch = null }) {
  const label = demoBadgeLabel(enabled);

  if (!label) return null;

  const switchButton = switchLabel && onSwitch ? createElement('button', {
    type: 'button',
    onClick: onSwitch,
    style: {
      pointerEvents: 'auto',
      marginLeft: 8,
      padding: '2px 8px',
      border: '1px solid var(--border)',
      borderRadius: 999,
      background: 'var(--bg-tertiary)',
      color: 'var(--accent)',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: 'inherit',
    },
  }, switchLabel) : null;

  return createElement('div', {
    'aria-live': 'polite',
    style: {
      // Bottom centre, click-through: the corners hold the compose window's buttons and the user menu.
      // On a phone the open sidebar's user menu spans the whole bottom row, so the badge sits above it.
      position: 'fixed',
      left: '50%',
      bottom: narrowScreen() ? 76 : 12,
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
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      // On a phone the text and the button wrap onto two lines instead of running off both sides.
      flexWrap: 'wrap',
      rowGap: 6,
      textAlign: 'center',
      width: 'max-content',
      maxWidth: 'calc(100% - 24px)',
      boxSizing: 'border-box',
    },
  }, `${label} — local data${roleLabel ? ` · ${roleLabel}` : ''}`, switchButton);
}
