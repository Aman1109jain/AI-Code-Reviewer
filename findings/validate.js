'use strict';
// Everything that comes out of the AI model or Semgrep is untrusted input: it ends up
// in the database, on the dashboard and in a public GitHub comment. This is the single
// choke point that forces it into the shape the rest of the app (and the database
// CHECK constraints) expect.
const SEVERITIES = ['blocking', 'warning', 'nitpick'];
const CATEGORIES = ['security', 'performance', 'maintainability', 'readability'];
const MAX_FINDINGS = 200;
const LIMITS = { filePath: 500, issue: 4000, suggestion: 4000 };

const clean = (v, max) =>
  String(v ?? '')
    .replace(/\u0000/g, '') // Postgres rejects NUL bytes
    .trim()
    .slice(0, max);

function normalizeFindings(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const issue = clean(item.issue, LIMITS.issue);
    if (!issue) continue;
    out.push({
      filePath: clean(item.filePath, LIMITS.filePath) || '(unknown file)',
      severity: SEVERITIES.includes(item.severity) ? item.severity : 'warning',
      category: CATEGORIES.includes(item.category) ? item.category : 'maintainability',
      issue,
      suggestion: clean(item.suggestion, LIMITS.suggestion),
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

module.exports = { normalizeFindings, SEVERITIES, CATEGORIES, MAX_FINDINGS };
