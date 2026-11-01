import { useCallback, useEffect, useState } from 'react';
import adminApi from '../../adminApi.js';
import { errorMessage } from '../../http.js';
import { Notice, Spinner } from './ui.jsx';
import { AdminLogin, AdminInitialPassword, AdminMfaSetup, AdminMfaVerify } from './AdminAuth.jsx';
import AdminConsole from './AdminConsole.jsx';

// Decides which screen to show from the server's view of this browser's admin session:
// signed out -> password -> (new password) -> MFA setup / MFA code -> console.
export default function AdminPage() {
  const [state, setState] = useState({ loading: true });

  const refresh = useCallback(async () => {
    try {
      const s = await adminApi.session();
      setState({ loading: false, ...s });
    } catch (err) {
      setState({ loading: false, authenticated: false, error: errorMessage(err) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => setState({ loading: false, authenticated: false, notice: 'Your admin session ended. Please sign in again.' });
    window.addEventListener('admin-session-expired', onExpired);
    return () => window.removeEventListener('admin-session-expired', onExpired);
  }, []);

  if (state.loading) return <div className="state-msg"><Spinner /></div>;
  if (state.error) return <Notice kind="error">{state.error}</Notice>;
  if (!state.authenticated) return <AdminLogin onDone={refresh} notice={state.notice} />;

  switch (state.stage) {
    case 'password_change': return <AdminInitialPassword onDone={refresh} />;
    case 'mfa_setup': return <AdminMfaSetup onDone={refresh} />;
    case 'mfa_pending': return <AdminMfaVerify onDone={refresh} />;
    default: return <AdminConsole admin={state.admin} onSignedOut={refresh} />;
  }
}
