import { useId } from 'react';

export default function IntegrationCard({
  icon, title, description, status, active, expanded, onToggle, children,
}) {
  const panelId = useId();

  return (
    <section className="admin-integration-card">
      <button
        type="button"
        className="admin-integration-header"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
      >
        {icon}
        <span className="admin-integration-label">
          <span className="admin-integration-title">{title}</span>
          <span className="admin-integration-description">{description}</span>
        </span>
        {status && (
          <span className="admin-integration-status" data-active={Boolean(active)}>{status}</span>
        )}
        <svg className="admin-integration-chevron" width="14" height="14" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <div id={panelId} className="admin-integration-panel" hidden={!expanded}>
        {expanded && children}
      </div>
    </section>
  );
}
