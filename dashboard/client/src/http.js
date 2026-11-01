import axios from 'axios';

// One axios instance for the whole app.
//
// The API is always reached on the SAME origin as the page: in development Vite
// proxies /api to the server (see vite.config.js); in production Express serves the
// dashboard itself. Same-origin means no CORS, and the login cookies (SameSite) work.
export const client = axios.create({ baseURL: '/api', withCredentials: true });

// CSRF: every state-changing request must carry the token the server issues from
// GET /api/csrf. It is fetched lazily, cached, and re-fetched after any sign-in or
// sign-out (the server ties it to the session) or if the server says it is stale.
let csrfToken = null;
let csrfPending = null;

async function ensureCsrf(force = false) {
  if (!force && csrfToken) return csrfToken;
  if (!csrfPending) {
    csrfPending = client
      .get('/csrf')
      .then((r) => {
        csrfToken = r.data.token;
        return csrfToken;
      })
      .finally(() => {
        csrfPending = null;
      });
  }
  return csrfPending;
}

export function resetCsrf() {
  csrfToken = null;
}

const UNSAFE = new Set(['post', 'put', 'patch', 'delete']);

client.interceptors.request.use(async (config) => {
  if (UNSAFE.has(String(config.method).toLowerCase())) {
    config.headers['X-CSRF-Token'] = await ensureCsrf();
  }
  return config;
});

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { response, config } = error;
    if (response?.status === 403 && response.data?.code === 'csrf_invalid' && config && !config.__csrfRetried) {
      config.__csrfRetried = true;
      config.headers['X-CSRF-Token'] = await ensureCsrf(true);
      return client(config);
    }
    throw error;
  }
);

// Readable message from a failed request.
export function errorMessage(err, fallback = 'Something went wrong. Please try again.') {
  return err?.response?.data?.error || (err?.response ? fallback : 'Could not reach the server. Check your connection.');
}
