import { client, resetCsrf } from './http.js';

// Everything the admin console talks to. Calls that change who is signed in reset the
// cached CSRF token (the server issues a new one tied to the new session).
const data = (p) => p.then((r) => r.data);
const afterAuth = (p) => p.then((r) => { resetCsrf(); return r.data; });

// If the admin session ends (idle timeout, signed out elsewhere, account disabled) any
// admin call answers 401; tell the page so it can show the sign-in form again.
client.interceptors.response.use(
  (r) => r,
  (err) => {
    const url = String(err.config?.url || '');
    if (err.response?.status === 401 && err.response.data?.code === 'admin_auth_required' && url.startsWith('/admin/') && !url.startsWith('/admin/auth/')) {
      window.dispatchEvent(new Event('admin-session-expired'));
    }
    return Promise.reject(err);
  }
);

export const adminApi = {
  session: () => data(client.get('/admin/auth/session')),
  login: (username, password) => afterAuth(client.post('/admin/auth/login', { username, password })),
  logout: () => afterAuth(client.post('/admin/auth/logout')),
  initialPassword: (currentPassword, newPassword) => afterAuth(client.post('/admin/auth/password/initial', { currentPassword, newPassword })),
  mfaSetup: () => data(client.post('/admin/auth/mfa/setup')),
  mfaEnable: (code) => afterAuth(client.post('/admin/auth/mfa/enable', { code })),
  mfaVerify: (body) => afterAuth(client.post('/admin/auth/mfa/verify', body)),

  me: () => data(client.get('/admin/me')),
  updateMe: (body) => data(client.patch('/admin/me', body)),
  changePassword: (currentPassword, newPassword) => afterAuth(client.post('/admin/me/password', { currentPassword, newPassword })),
  regenerateRecoveryCodes: (currentPassword, code) => data(client.post('/admin/me/recovery-codes', { currentPassword, code })),

  listUsers: () => data(client.get('/admin/users')),
  createUser: (body) => data(client.post('/admin/users', body)),
  updateUser: (id, body) => data(client.patch(`/admin/users/${id}`, body)),
  resetUserPassword: (id, currentPassword) => data(client.post(`/admin/users/${id}/reset-password`, { currentPassword })),
  resetUserMfa: (id, currentPassword) => data(client.post(`/admin/users/${id}/reset-mfa`, { currentPassword })),
  unlockUser: (id) => data(client.post(`/admin/users/${id}/unlock`)),
  deleteUser: (id, currentPassword) => data(client.delete(`/admin/users/${id}`, { data: { currentPassword } })),

  dbTables: () => data(client.get('/admin/db/tables')),
  dbRows: (table, params) => data(client.get(`/admin/db/tables/${table}/rows`, { params })),
  dbRow: (table, id) => data(client.get(`/admin/db/tables/${table}/rows/${encodeURIComponent(id)}`)),
  dbTransaction: (ops) => data(client.post('/admin/db/transactions', { ops })),
};

export default adminApi;
