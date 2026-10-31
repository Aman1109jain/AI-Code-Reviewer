import axios from 'axios';

// The API runs on a different port (3000) than the Vite dev server (5173).
const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

// withCredentials: send the login cookie so returning users stay connected.
const client = axios.create({ baseURL: `${API_BASE}/api`, withCredentials: true });

export const api = {
  API_BASE,
  getReviews: () => client.get('/reviews').then((r) => r.data),
  getReview: (id) => client.get(`/reviews/${id}/findings`).then((r) => r.data),
  getSeverityCounts: () => client.get('/analytics/severity').then((r) => r.data),

  getGithubStatus: () => client.get('/github/status').then((r) => r.data),
  getGithubRepos: () => client.get('/github/repos').then((r) => r.data),
  // The login itself is a full-page redirect to GitHub (see GithubContext.connect).
  githubLoginUrl: (returnTo = '/') => `${API_BASE}/api/auth/github/login?returnTo=${encodeURIComponent(returnTo)}`,
  connectWithToken: (token) => client.post('/auth/github/token', { token }).then((r) => r.data),
  githubLogout: () => client.post('/auth/logout').then((r) => r.data),

  getTableNames: () => client.get('/tables').then((r) => r.data),
  getTable: (name) => client.get(`/tables/${name}`).then((r) => r.data),

  // payload: { code, fileName } for pasted code, or { files: [{ path, content }] } for uploads
  runQuickReview: (payload) => client.post('/quick-review', payload).then((r) => r.data),
  createPrFromReview: (reviewId, payload) =>
    client.post(`/quick-review/${reviewId}/create-pr`, payload).then((r) => r.data),
};

export default api;
