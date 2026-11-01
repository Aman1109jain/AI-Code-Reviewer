import { useEffect, useState } from 'react';
import adminApi from '../../adminApi.js';
import { errorMessage } from '../../http.js';
import { Field, Notice, Spinner, OneTimeDialog, PASSWORD_HINT } from './ui.jsx';

// Everything an admin can change about their own account. Each change asks for the
// current password again, so a stolen open browser tab can't take over the account.
export default function AdminAccount({ me, onChanged }) {
  const [remaining, setRemaining] = useState(null);
  useEffect(() => {
    adminApi.me().then((r) => setRemaining(r.recoveryCodesRemaining)).catch(() => {});
  }, []);

  return (
    <div className="adm-stack">
      <ProfileForm me={me} onChanged={onChanged} />
      <PasswordForm />
      <RecoveryForm remaining={remaining} onRegenerated={setRemaining} />
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);
  const run = (fn, success) => async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await fn();
      setOk(success);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, ok, run };
}

function ProfileForm({ me, onChanged }) {
  const [username, setUsername] = useState(me.username);
  const [email, setEmail] = useState(me.email);
  const [password, setPassword] = useState('');
  const { busy, error, ok, run } = useAction();
  const changed = username.trim().toLowerCase() !== me.username || email.trim().toLowerCase() !== me.email;

  return (
    <form className="panel adm-card" onSubmit={run(async () => {
      const body = { currentPassword: password };
      if (username.trim().toLowerCase() !== me.username) body.username = username.trim();
      if (email.trim().toLowerCase() !== me.email) body.email = email.trim();
      const r = await adminApi.updateMe(body);
      onChanged(r.admin);
      setPassword('');
    }, 'Profile updated.')}>
      <h3>Profile</h3>
      <div className="adm-grid-2">
        <Field label="Username"><input className="modal-input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></Field>
        <Field label="Email"><input className="modal-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
      </div>
      <Field label="Current password (required to save)"><input className="modal-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{ok}</Notice>
      <button className="btn-primary" disabled={busy || !changed || !password}>{busy && <Spinner />} Save profile</button>
    </form>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, ok, run } = useAction();
  return (
    <form className="panel adm-card" onSubmit={run(async () => {
      if (next !== again) throw Object.assign(new Error('mismatch'), { response: { data: { error: 'The new passwords do not match.' } } });
      await adminApi.changePassword(current, next);
      setCurrent(''); setNext(''); setAgain('');
    }, 'Password changed. Your other signed-in browsers were signed out.')}>
      <h3>Change password</h3>
      <Field label="Current password"><input className="modal-input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></Field>
      <div className="adm-grid-2">
        <Field label="New password" hint={PASSWORD_HINT}><input className="modal-input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
        <Field label="New password (again)"><input className="modal-input" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <Notice kind="error">{error}</Notice>
      <Notice kind="ok">{ok}</Notice>
      <button className="btn-primary" disabled={busy || !current || !next || !again}>{busy && <Spinner />} Change password</button>
    </form>
  );
}

function RecoveryForm({ remaining, onRegenerated }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);
  const { busy, error, run } = useAction();
  return (
    <form className="panel adm-card" onSubmit={run(async () => {
      const r = await adminApi.regenerateRecoveryCodes(password, code);
      setCodes(r.recoveryCodes);
      onRegenerated(r.recoveryCodes.length);
      setPassword(''); setCode('');
    })}>
      <h3>Recovery codes</h3>
      <p className="adm-muted">{remaining === null ? '' : `${remaining} unused recovery code${remaining === 1 ? '' : 's'} left.`} Generating new codes makes all the old ones stop working.</p>
      <div className="adm-grid-2">
        <Field label="Current password"><input className="modal-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="Code from your authenticator"><input className="modal-input adm-code-input" inputMode="numeric" maxLength={6} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></Field>
      </div>
      <Notice kind="error">{error}</Notice>
      <button className="btn-ghost-sm" disabled={busy || !password || code.length !== 6}>{busy && <Spinner />} Generate new recovery codes</button>
      {codes && <OneTimeDialog title="Your new recovery codes" intro="Each code works once. They will not be shown again." items={codes.map((c, i) => ({ label: `Code ${i + 1}`, value: c }))} copyText={codes.join('\n')} onClose={() => setCodes(null)} />}
    </form>
  );
}
