import { client, resetCsrf } from './http.js';

export const api = {
  getReviews: () => client.get('/reviews').then((r) => r.data),
  getReview: (id) => client.get(`/reviews/${id}/findings`).then((r) => r.data),
  getSeverityCounts: () => client.get('/analytics/severity').then((r) => r.data),

  getGithubStatus: () => client.get('/github/status').then((r) => r.data),
  getGithubRepos: () => client.get('/github/repos').then((r) => r.data),
  connectWithToken: (token) =>
    client.post('/auth/github/token', { token }).then((r) => {
      resetCsrf(); // the session changed, so the CSRF token must be re-issued
      return r.data;
    }),
  githubLogout: () =>
    client.post('/auth/logout').then((r) => {
      resetCsrf();
      return r.data;
    }),

  // payload: { code, fileName } for pasted code, or { files: [{ path, content }] } for uploads
  runQuickReview: (payload) => client.post('/quick-review', payload).then((r) => r.data),
  createPrFromReview: (reviewId, payload) => client.post(`/quick-review/${reviewId}/create-pr`, payload).then((r) => r.data),
};

export default api;
