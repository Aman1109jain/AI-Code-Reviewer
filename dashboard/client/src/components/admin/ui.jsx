import { useEffect, useState } from 'react';
import { X, Copy, Check, Loader2 } from 'lucide-react';
import { errorMessage } from '../../http.js';

export function Field({ label, hint, children }) {
  return (
    <label className="adm-field">
      <span className="adm-label">{label}</span>
      {children}
      {hint && <span className="adm-hint">{hint}</span>}
    </label>
  );
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`adm-notice adm-notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function Modal({ title, onClose, children, wide = false }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal adm-modal ${wide ? 'adm-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{title}</h3>
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close" type="button">
              <X size={16} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner() {
  return <Loader2 size={15} className="spin" />;
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost-sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is still selectable on screen */
        }
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />} {done ? 'Copied' : label}
    </button>
  );
}

// Asks for the signed-in admin's own password before a sensitive action.
export function ReauthDialog({ title, description, confirmLabel = 'Confirm', danger = false, onConfirm, onClose }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {description && <p className="adm-muted">{description}</p>}
        <Field label="Your password">
          <input className="modal-input" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <div className="adm-actions">
          <button type="button" className="btn-ghost-sm" onClick={onClose}>Cancel</button>
          <button type="submit" className={danger ? 'btn-danger-sm' : 'btn-primary'} disabled={!password || busy}>
            {busy && <Spinner />} {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Shows something that will never be displayed again (temporary password, recovery codes).
export function OneTimeDialog({ title, intro, items, copyText, onClose }) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="adm-muted">{intro}</p>
      <div className="adm-secret-list">
        {items.map((it) => (
          <div key={it.label} className="adm-secret">
            <span className="adm-label">{it.label}</span>
            <code>{it.value}</code>
          </div>
        ))}
      </div>
      <div className="adm-actions">
        <CopyButton text={copyText || items.map((i) => i.value).join('\n')} label="Copy" />
        <button className="btn-primary" onClick={onClose}>I have saved it</button>
      </div>
    </Modal>
  );
}

export const PASSWORD_HINT = 'At least 12 characters, not a common password, with three of: lowercase, uppercase, digits, symbols (or 16+ characters).';
