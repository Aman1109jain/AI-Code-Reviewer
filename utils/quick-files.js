// Helpers for Quick Check reviews of pasted code, single files and whole folders.
// Everything in here is a pure function (no network, no DB) so it's easy to test.
//
// The dashboard filters uploads before sending them, but the server re-checks
// everything here — never trust the client for limits or paths.
const { computeOverallScore } = require('../review-engine/merge-findings');

const LIMITS = {
  MAX_FILES: 50,
  MAX_FILE_BYTES: 150 * 1024,
  MAX_TOTAL_BYTES: 300 * 1024,
  // Max characters of diff sent to the AI in one request. Bigger uploads are
  // split into several batches that are reviewed a few at a time.
  CHUNK_CHARS: 60000,
};

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'psd', 'pdf',
  'zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'jar', 'war', 'class', 'pyc',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'iso', 'dmg',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'webm',
  'sqlite', 'db', 'map',
]);

// Files that commonly hold credentials. They are never sent to the AI.
const SECRET_FILE_RE = /(^|\/)(\.env(\..*)?|id_rsa.*|id_ed25519.*|[^/]*\.(pem|key|p12|pfx))$/i;

// Returns a clean, forward-slash relative path, or null if it isn't safe/usable.
function sanitizePath(input) {
  if (typeof input !== 'string') return null;
  let p = input.replace(/\\/g, '/').replace(/\0/g, '').trim();
  const segments = p.split('/').filter((s) => s !== '' && s !== '.');
  if (!segments.length || segments.includes('..')) return null;
  p = segments.join('/');
  if (p.length > 300) return null;
  // " b/" inside a path would confuse the "diff --git a/x b/y" header parser.
  if (p.includes(' b/')) return null;
  return p;
}

function extOf(path) {
  const name = path.split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Collapses [{path, reason}] into [{reason, count, examples}] for display.
function groupSkipped(list) {
  const groups = new Map();
  for (const { path, reason } of list) {
    if (!groups.has(reason)) groups.set(reason, { reason, count: 0, examples: [] });
    const g = groups.get(reason);
    g.count += 1;
    if (g.examples.length < 3) g.examples.push(path);
  }
  return [...groups.values()];
}

// Validates files sent by the client. Returns the files that are fine to
// review plus a grouped summary of what was skipped and why.
function normalizeFiles(files) {
  const accepted = [];
  const skipped = [];
  const seen = new Set();
  let total = 0;
  const maxKb = LIMITS.MAX_FILE_BYTES / 1024;

  for (const f of Array.isArray(files) ? files : []) {
    const path = sanitizePath(f && f.path);
    if (!path) {
      skipped.push({ path: String((f && f.path) ?? ''), reason: 'unsupported path' });
      continue;
    }
    if (typeof f.content !== 'string') {
      skipped.push({ path, reason: 'not text' });
      continue;
    }
    if (seen.has(path)) {
      skipped.push({ path, reason: 'duplicate path' });
      continue;
    }
    if (SECRET_FILE_RE.test(path)) {
      skipped.push({ path, reason: 'environment / key file (never sent to the AI)' });
      continue;
    }
    if (BINARY_EXT.has(extOf(path)) || f.content.includes('\0')) {
      skipped.push({ path, reason: 'binary or non-text file' });
      continue;
    }
    if (!f.content.trim()) {
      skipped.push({ path, reason: 'empty file' });
      continue;
    }
    const bytes = Buffer.byteLength(f.content, 'utf8');
    if (bytes > LIMITS.MAX_FILE_BYTES) {
      skipped.push({ path, reason: `larger than ${maxKb} KB` });
      continue;
    }
    if (accepted.length >= LIMITS.MAX_FILES) {
      skipped.push({ path, reason: `over the ${LIMITS.MAX_FILES}-file limit` });
      continue;
    }
    if (total + bytes > LIMITS.MAX_TOTAL_BYTES) {
      skipped.push({ path, reason: 'over the total size limit' });
      continue;
    }
    seen.add(path);
    total += bytes;
    accepted.push({ path, content: f.content });
  }

  return { files: accepted, skipped: groupSkipped(skipped) };
}

// Wraps one file in a synthetic "new file" unified diff, so it can go through
// the exact same static-analysis + AI pipeline used for real pull requests.
function buildFileDiff(path, content) {
  const lines = content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..0000000',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');
}

function buildSyntheticDiff(files) {
  return files.map((f) => buildFileDiff(f.path, f.content)).join('\n');
}

// Splits files into batches that each stay under maxChars of diff.
function chunkFiles(files, maxChars = LIMITS.CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const f of files) {
    const len = f.content.length + f.path.length * 2 + 120;
    if (current.length && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// Runs fn over items with at most `limit` running at once; keeps result order.
// fn is expected to handle its own errors.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// A readable name for the dashboard's "Repo / File" column.
function labelForFiles(files) {
  if (files.length === 1) return files[0].path.slice(0, 255);
  const roots = new Set(files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : null)));
  const root = roots.size === 1 ? [...roots][0] : null;
  const label = root ? `${root}/ (${files.length} files)` : `${files.length} files`;
  return label.slice(0, 255);
}

// The AI sometimes echoes a path as "b/src/x.py" or drops a leading folder.
// Map whatever it returned back onto one of the real uploaded paths.
function matchPath(p, known) {
  if (typeof p !== 'string') return null;
  const clean = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (known.has(clean)) return clean;
  const stripped = clean.replace(/^[ab]\//, '');
  if (known.has(stripped)) return stripped;
  const hits = [...known.keys()].filter((k) => k.endsWith(`/${stripped}`) || stripped.endsWith(`/${k}`));
  return hits.length === 1 ? hits[0] : null;
}

function canonicalizeFindings(files, findings) {
  const known = new Map(files.map((f) => [f.path, true]));
  return findings.map((f) => ({ ...f, filePath: matchPath(f.filePath, known) || f.filePath }));
}

// Overall score for an upload = average of each file's own score (files with
// no findings count as 100). A plain "100 minus penalties" would drop to 0 for
// any big folder just because it has more code in it.
function computeUploadScore(files, findings) {
  const buckets = new Map(files.map((f) => [f.path, []]));
  const other = [];
  for (const f of findings) {
    if (buckets.has(f.filePath)) buckets.get(f.filePath).push(f);
    else other.push(f);
  }
  const scores = [...buckets.values()].map(computeOverallScore);
  if (other.length) scores.push(computeOverallScore(other));
  if (!scores.length) return 100;
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

// Branch names we're willing to create from the dashboard.
function isValidBranchName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9._\-/]+$/.test(name) &&
    !name.includes('..') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    name.length <= 200
  );
}

module.exports = {
  LIMITS,
  sanitizePath,
  normalizeFiles,
  groupSkipped,
  buildFileDiff,
  buildSyntheticDiff,
  chunkFiles,
  mapWithConcurrency,
  labelForFiles,
  matchPath,
  canonicalizeFindings,
  computeUploadScore,
  isValidBranchName,
};
