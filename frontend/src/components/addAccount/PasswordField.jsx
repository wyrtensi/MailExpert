import { forwardRef, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// A password input with a show/hide button beside it (44 x 44, named and pressed-state aware, the
// pattern of the account settings form). The value stays in the caller's local state; showing it
// only changes the input type. `autoComplete` defaults to new-password: these are passwords of
// other services, and the browser must not fill the panel's own saved sign-in into them.
const PasswordField = forwardRef(function PasswordField({
  id, value, onChange, autoComplete = 'new-password', readOnly = false, describedBy,
}, ref) {
  const { t } = useTranslation();
  const [shown, setShown] = useState(false);
  // An emptied field (sent, cleared) starts hidden again.
  useEffect(() => { if (!value) setShown(false); }, [value]);
  return (
    <div className="add-account-password">
      <input
        ref={ref}
        id={id}
        type={shown ? 'text' : 'password'}
        className="add-account-input"
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        aria-describedby={describedBy}
        onChange={onChange}
      />
      <button
        type="button"
        className="add-account-reveal"
        aria-controls={id}
        aria-pressed={shown}
        aria-label={t(shown ? 'common.hidePassword' : 'common.showPassword')}
        title={t(shown ? 'common.hidePassword' : 'common.showPassword')}
        onClick={() => setShown((current) => !current)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          {shown
            ? <><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></>
            : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></>}
        </svg>
      </button>
    </div>
  );
});

export default PasswordField;
