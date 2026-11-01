import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Pencil, KeyRound, Smartphone, Unlock, Trash2 } from 'lucide-react';
import adminApi from '../../adminApi.js';
import { errorMessage } from '../../http.js';
import { Field, Notice, Spinner, Modal, ReauthDialog, OneTimeDialog } from './ui.jsx';

const fmt = (d) => (d ? new Date(d).toLocaleString() : 'never');
const isLocked = (u) => u.locked_until && new Date(u.locked_until) > new Date();

export default function AdminUsers({ me }) {
  const isSuper = me.role === 'superadmin';
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [flash, setFlash] = useState(null);
  const [dialog, setDialog] = useState(null); // {type, user}
  const [secret, setSecret] = useState(null);

  const load = useCallback(() => {
    adminApi.listUsers().then((r) => setUsers(r.users)).catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const done = (message) => { setDialog(null); setFlash(message); load(); };

  return (
    <div className="adm-stack">
      <AddAdminForm isSuper={isSuper} onCreated={(r) => { setSecret({ title: 'Admin created', intro: `Give "${r.user.username}" this temporary password in person or over a secure channel. It is shown only once. They must choose their own password and set up an authenticator app at first sign-in.`, items: [{ label: 'Username', value: r.user.username }, { label: 'Temporary password', value: r.temporaryPassword }] }); load(); }} />

      <div className="panel">
        <div className="panel-header">
          <h3>Administrators</h3>
          <span className="panel-header-hint">{isSuper ? 'You can manage every account.' : 'You can add admins and edit your own account. Only a superadmin can manage others.'}</span>
        </div>
        <Notice kind="error">{error}</Notice>
        <Notice kind="ok">{flash}</Notice>
        {!users && !error && <div className="state-msg"><Spinner /></div>}
        {users && (
          <div className="adm-grid-wrap">
            <table className="adm-table">
              <thead><tr><th>Username</th><th>Email</th><th>Role</th><th>Status</th><th>MFA</th><th>Last sign-in</th>{isSuper && <th aria-label="Actions" />}</tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><b>{u.username}</b>{u.id === me.id && <span className="adm-you"> (you)</span>}</td>
                    <td>{u.email}</td>
                    <td><span className={`badge adm-role adm-role-${u.role}`}>{u.role}</span></td>
                    <td>
                      {!u.is_active ? <span className="badge adm-off">disabled</span> : isLocked(u) ? <span className="badge adm-warn">locked</span> : u.must_change_password ? <span className="badge adm-warn">invited</span> : <span className="badge adm-on">active</span>}
                    </td>
                    <td>{u.totp_enabled ? 'on' : <span className="adm-muted">not set up</span>}</td>
                    <td>{fmt(u.last_login_at)}</td>
                    {isSuper && (
                      <td className="adm-row-actions">
                        <button className="icon-btn" title="Edit" onClick={() => setDialog({ type: 'edit', user: u })}><Pencil size={15} /></button>
                        {isLocked(u) && <button className="icon-btn" title="Unlock" onClick={async () => { try { await adminApi.unlockUser(u.id); done(`${u.username} unlocked.`); } catch (e) { setError(errorMessage(e)); } }}><Unlock size={15} /></button>}
                        <button className="icon-btn" title="Reset password" onClick={() => setDialog({ type: 'password', user: u })}><KeyRound size={15} /></button>
                        <button className="icon-btn" title="Reset two-step verification" onClick={() => setDialog({ type: 'mfa', user: u })}><Smartphone size={15} /></button>
                        {u.id !== me.id && <button className="icon-btn danger" title="Delete" onClick={() => setDialog({ type: 'delete', user: u })}><Trash2 size={15} /></button>}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.type === 'edit' && <EditDialog user={dialog.user} isSelf={dialog.user.id === me.id} onClose={() => setDialog(null)} onSaved={() => done(`${dialog.user.username} updated.`)} />}
      {dialog?.type === 'password' && (
        <ReauthDialog title={`Reset password for ${dialog.user.username}`} description="They will be signed out everywhere and given a new temporary password that they must replace at next sign-in." confirmLabel="Reset password"
          onClose={() => setDialog(null)}
          onConfirm={async (pw) => { const r = await adminApi.resetUserPassword(dialog.user.id, pw); setDialog(null); load(); setSecret({ title: 'Temporary password', intro: 'Shown only once. They must replace it at next sign-in.', items: [{ label: 'Username', value: r.username }, { label: 'Temporary password', value: r.temporaryPassword }] }); }} />
      )}
      {dialog?.type === 'mfa' && (
        <ReauthDialog title={`Reset two-step verification for ${dialog.user.username}`} description="Removes their authenticator and recovery codes and signs them out. They set up a new authenticator at next sign-in." confirmLabel="Reset two-step verification"
          onClose={() => setDialog(null)} onConfirm={async (pw) => { await adminApi.resetUserMfa(dialog.user.id, pw); done(`Two-step verification reset for ${dialog.user.username}.`); }} />
      )}
      {dialog?.type === 'delete' && (
        <ReauthDialog title={`Delete ${dialog.user.username}`} description="This permanently removes the account and signs it out. This cannot be undone." confirmLabel="Delete account" danger
          onClose={() => setDialog(null)} onConfirm={async (pw) => { await adminApi.deleteUser(dialog.user.id, pw); done(`${dialog.user.username} deleted.`); }} />
      )}
      {secret && <OneTimeDialog {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function AddAdminForm({ isSuper, onCreated }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await adminApi.createUser({ username: username.trim(), email: email.trim(), ...(isSuper ? { role } : {}) });
      setUsername(''); setEmail(''); setRole('admin');
      onCreated(r);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel adm-card" onSubmit={submit}>
      <h3><UserPlus size={16} /> Add an administrator</h3>
      <div className={isSuper ? 'adm-grid-3' : 'adm-grid-2'}>
        <Field label="Username" hint="3-32 characters: letters, digits, . _ -"><input className="modal-input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" spellCheck={false} /></Field>
        <Field label="Email"><input className="modal-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {isSuper && (
          <Field label="Role">
            <select className="modal-input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="admin">admin</option>
              <option value="superadmin">superadmin</option>
            </select>
          </Field>
        )}
      </div>
      <Notice kind="error">{error}</Notice>
      <button className="btn-primary" disabled={busy || !username.trim() || !email.trim()}>{busy && <Spinner />} Create account</button>
    </form>
  );
}

function EditDialog({ user, isSelf, onClose, onSaved }) {
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState(user.role);
  const [active, setActive] = useState(user.is_active);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const body = { currentPassword: password };
    if (username.trim().toLowerCase() !== user.username) body.username = username.trim();
    if (email.trim().toLowerCase() !== user.email) body.email = email.trim();
    if (!isSelf && role !== user.role) body.role = role;
    if (!isSelf && active !== user.is_active) body.isActive = active;
    if (Object.keys(body).length === 1) { setError('Nothing to change.'); return; }
    setBusy(true);
    setError(null);
    try {
      await adminApi.updateUser(user.id, body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={`Edit ${user.username}`} onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Username"><input className="modal-input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" /></Field>
        <Field label="Email"><input className="modal-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {!isSelf && (
          <>
            <Field label="Role">
              <select className="modal-input" value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="admin">admin</option>
                <option value="superadmin">superadmin</option>
              </select>
            </Field>
            <label className="adm-check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Account is active (untick to disable and sign out)</label>
          </>
        )}
        <Field label="Your password (to confirm)"><input className="modal-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        <Notice kind="error">{error}</Notice>
        <div className="adm-actions">
          <button type="button" className="btn-ghost-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={busy || !password}>{busy && <Spinner />} Save</button>
        </div>
      </form>
    </Modal>
  );
}
