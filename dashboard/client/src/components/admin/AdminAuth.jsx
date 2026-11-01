import { useEffect, useRef, useState } from 'react';
import { ShieldCheck, KeyRound, Smartphone, LogOut, Download } from 'lucide-react';
import adminApi from '../../adminApi.js';
import { errorMessage } from '../../http.js';
import { Field, Notice, Spinner, CopyButton, PASSWORD_HINT } from './ui.jsx';

function AuthCard({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="adm-auth-wrap">
      <div className="panel adm-auth-card">
        <div className="adm-auth-icon"><Icon size={22} /></div>
        <h2>{title}</h2>
        {subtitle && <p className="adm-muted">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

function useSubmit(action) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (e) => {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
  };
  return { busy, error, run, setError };
}

export function AdminLogin({ onDone, notice }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    await adminApi.login(username.trim(), password);
    setPassword('');
    await onDone();
  });
  return (
    <AuthCard icon={ShieldCheck} title="Admin sign-in" subtitle="For administrators only. Accounts are created from the server terminal.">
      <form onSubmit={run}>
        <Notice kind="info">{notice}</Notice>
        <Field label="Username">
          <input className="modal-input" autoFocus autoComplete="username" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="modal-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Notice kind="error">{error}</Notice>
        <button className="btn-primary modal-wide" type="submit" disabled={busy || !username.trim() || !password}>
          {busy ? <Spinner /> : <KeyRound size={15} />} Continue
        </button>
        <p className="adm-muted adm-small">No account yet? On the server run <code>npm run create-admin</code>.</p>
      </form>
    </AuthCard>
  );
}

export function SignOutLink({ onDone }) {
  return (
    <button type="button" className="adm-link" onClick={async () => { await adminApi.logout().catch(() => {}); await onDone(); }}>
      <LogOut size={13} /> Cancel and sign out
    </button>
  );
}

// First sign-in of an account someone else created (or after a reset): choose your own password.
export function AdminInitialPassword({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, run } = useSubmit(async () => {
    if (next !== again) throw Object.assign(new Error('mismatch'), { response: { data: { error: 'The new passwords do not match.' } } });
    await adminApi.initialPassword(current, next);
    await onDone();
  });
  return (
    <AuthCard icon={KeyRound} title="Choose your own password" subtitle="You signed in with a temporary password. Replace it now - only you should know your password.">
      <form onSubmit={run}>
        <Field label="Temporary password"><input className="modal-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint={PASSWORD_HINT}><input className="modal-input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="New password (again)"><input className="modal-input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
        <Notice kind="error">{error}</Notice>
        <button className="btn-primary modal-wide" type="submit" disabled={busy || !current || !next || !again}>{busy && <Spinner />} Save password</button>
        <SignOutLink onDone={onDone} />
      </form>
    </AuthCard>
  );
}

function RecoveryCodes({ codes, onContinue }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`AI Code Reviewer - admin recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <AuthCard icon={KeyRound} title="Save your recovery codes" subtitle="If you lose your phone, each of these codes lets you sign in once. They are shown only now - store them somewhere safe (a password manager, not a screenshot).">
      <div className="adm-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
      <div className="adm-actions adm-actions-start">
        <CopyButton text={text} label="Copy all" />
        <button type="button" className="btn-ghost-sm" onClick={download}><Download size={13} /> Download</button>
      </div>
      <label className="adm-check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I have saved these codes
      </label>
      <button className="btn-primary modal-wide" disabled={!saved} onClick={onContinue}>Continue to the admin console</button>
    </AuthCard>
  );
}

// Mandatory MFA enrolment: scan the QR code, confirm with a code.
export function AdminMfaSetup({ onDone }) {
  const [setup, setSetup] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // React StrictMode runs effects twice in development; only one secret may be issued
    started.current = true;
    adminApi.mfaSetup().then(setSetup).catch((e) => setLoadError(errorMessage(e)));
  }, []);

  const { busy, error, run } = useSubmit(async () => {
    const r = await adminApi.mfaEnable(code.trim());
    setCodes(r.recoveryCodes);
  });

  if (codes) return <RecoveryCodes codes={codes} onContinue={onDone} />;

  return (
    <AuthCard icon={Smartphone} title="Set up two-step verification" subtitle="Admin accounts require an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password...).">
      {loadError && <Notice kind="error">{loadError}</Notice>}
      {!setup && !loadError && <div className="state-msg"><Spinner /></div>}
      {setup && (
        <form onSubmit={run}>
          <ol className="modal-steps">
            <li>Open your authenticator app and add an account by scanning this code.</li>
            <li>Type the 6-digit code it shows to finish.</li>
          </ol>
          <div className="adm-qr"><img src={setup.qr} alt="QR code for your authenticator app" width="200" height="200" /></div>
          <details className="adm-details">
            <summary>Can't scan? Enter the key manually</summary>
            <code className="adm-key">{setup.secret.match(/.{1,4}/g).join(' ')}</code>
          </details>
          <Field label="6-digit code">
            <input className="modal-input adm-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Notice kind="error">{error}</Notice>
          <button className="btn-primary modal-wide" type="submit" disabled={busy || code.length !== 6}>{busy && <Spinner />} Verify and finish</button>
          <SignOutLink onDone={onDone} />
        </form>
      )}
    </AuthCard>
  );
}

export function AdminMfaVerify({ onDone }) {
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [expired, setExpired] = useState(false);
  const { busy, error, run } = useSubmit(async () => {
    try {
      await adminApi.mfaVerify(useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
    } catch (err) {
      if (err.response?.data?.code === 'mfa_session_expired') {
        setExpired(true);
        await onDone();
        return;
      }
      throw err;
    }
    await onDone();
  });
  return (
    <AuthCard icon={Smartphone} title="Two-step verification" subtitle={useRecovery ? 'Enter one of your saved recovery codes. Each works only once.' : 'Enter the 6-digit code from your authenticator app.'}>
      <form onSubmit={run}>
        {useRecovery ? (
          <Field label="Recovery code">
            <input className="modal-input" autoFocus autoComplete="off" spellCheck={false} placeholder="xxxx-xxxx-xxxx-xxxx" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        ) : (
          <Field label="6-digit code">
            <input className="modal-input adm-code-input" autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        <Notice kind="error">{error}</Notice>
        {expired && <Notice kind="error">Too many wrong codes. Please sign in again.</Notice>}
        <button className="btn-primary modal-wide" type="submit" disabled={busy || (useRecovery ? code.trim().length < 8 : code.length !== 6)}>{busy && <Spinner />} Verify</button>
        <div className="adm-links">
          <button type="button" className="adm-link" onClick={() => { setUseRecovery((v) => !v); setCode(''); }}>
            {useRecovery ? 'Use the authenticator app instead' : 'Lost your phone? Use a recovery code'}
          </button>
          <SignOutLink onDone={onDone} />
        </div>
      </form>
    </AuthCard>
  );
}
