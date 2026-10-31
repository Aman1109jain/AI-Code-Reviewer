// Helpers for the Quick Check file / folder upload.
//
// This does the friendly filtering in the browser (so a folder with 20,000
// files in node_modules doesn't get read at all). The server re-checks
// everything — see utils/quick-files.js — so keep the limits in sync with it.

export const LIMITS = {
  MAX_FILES: 50,
  MAX_FILE_BYTES: 150 * 1024,
  MAX_TOTAL_BYTES: 300 * 1024,
};

// Stop walking a dropped folder after this many entries — a safety valve.
const MAX_SCAN = 5000;

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '__pycache__', '.venv', 'venv', 'vendor', 'bower_components',
  'site-packages', '.idea', '.vscode', '.gradle', '.cache', '.turbo',
  '.pytest_cache', '.mypy_cache', '__MACOSX',
]);

const LOCK_FILES = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'pipfile.lock', 'poetry.lock',
  'composer.lock', 'gemfile.lock', 'cargo.lock', 'go.sum', 'bun.lockb',
  '.ds_store', 'thumbs.db',
]);

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'psd', 'pdf',
  'zip', 'gz', 'tar', 'tgz', '7z', 'rar', 'jar', 'war', 'class', 'pyc',
  'exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'lib', 'iso', 'dmg',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'webm',
  'sqlite', 'db', 'map',
]);

// Credentials never leave the browser.
const SECRET_FILE_RE = /(^|\/)(\.env(\..*)?|id_rsa.*|id_ed25519.*|[^/]*\.(pem|key|p12|pfx))$/i;

const REASON_SECRET = 'environment / key file (never sent to the AI)';

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extOf(path) {
  const name = path.split('/').pop();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

// Returns why a path should be skipped, or null if it looks reviewable.
export function skipReasonForPath(path) {
  const segments = path.split('/');
  const name = segments[segments.length - 1];
  const lower = name.toLowerCase();

  if (segments.slice(0, -1).some((s) => IGNORED_DIRS.has(s))) return 'ignored folder';
  if (LOCK_FILES.has(lower) || lower.endsWith('.lock')) return 'lock / generated file';
  if (/\.min\.(js|css)$/.test(lower) || /\.bundle\.js$/.test(lower)) return 'minified / bundled file';
  if (SECRET_FILE_RE.test(path)) return REASON_SECRET;
  if (BINARY_EXT.has(extOf(path))) return 'binary or non-text file';
  return null;
}

// "my-app/node_modules/lodash/x.js" -> "my-app/node_modules/"
function ignoredPrefix(path) {
  const segments = path.split('/');
  const i = segments.findIndex((s, idx) => idx < segments.length - 1 && IGNORED_DIRS.has(s));
  return i === -1 ? path : `${segments.slice(0, i + 1).join('/')}/`;
}

// [{path, reason}] -> [{reason, count, examples}] (so 20,000 skipped files in
// node_modules show up as one line, not 20,000).
export function groupSkipped(list) {
  const groups = new Map();
  for (const { path, reason } of list) {
    if (!groups.has(reason)) groups.set(reason, { reason, count: 0, examples: [] });
    const g = groups.get(reason);
    g.count += 1;
    if (g.examples.length < 3 && !g.examples.includes(path)) g.examples.push(path);
  }
  return [...groups.values()];
}

// <input type="file"> result -> [{ path, file }]. With a folder picker each
// file carries webkitRelativePath ("my-folder/src/a.py").
export function collectFromFileList(fileList) {
  return Array.from(fileList).map((file) => ({ path: file.webkitRelativePath || file.name, file }));
}

// Drag-and-drop -> { collected: [{path, file}], skipped: [{path, reason}] }.
// Folders are only available through the entry API, and the DataTransfer is
// only valid during the drop event — so everything we need from it is grabbed
// synchronously, before the first await.
export async function collectFromDrop(dataTransfer) {
  const plainFiles = Array.from(dataTransfer.files || []);
  const items = Array.from(dataTransfer.items || []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (!entries.length) {
    return { collected: collectFromFileList(plainFiles), skipped: [] };
  }

  const collected = [];
  const skipped = [];
  const state = { scanned: 0, truncated: false };
  for (const entry of entries) {
    await walkEntry(entry, collected, skipped, state);
  }
  if (state.truncated) skipped.push({ path: 'folder', reason: `too many files to scan (stopped at ${MAX_SCAN})` });
  return { collected, skipped };
}

async function walkEntry(entry, collected, skipped, state) {
  if (state.scanned >= MAX_SCAN) {
    state.truncated = true;
    return;
  }
  const path = String(entry.fullPath || entry.name).replace(/^\/+/, '');

  if (entry.isFile) {
    state.scanned += 1;
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    collected.push({ path, file });
    return;
  }

  if (entry.isDirectory) {
    if (IGNORED_DIRS.has(entry.name)) {
      skipped.push({ path: `${path}/`, reason: 'ignored folder' });
      return;
    }
    const reader = entry.createReader();
    let batch;
    do {
      // readEntries returns results in chunks (~100); keep going until empty.
      batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      for (const child of batch) {
        await walkEntry(child, collected, skipped, state);
      }
    } while (batch.length);
  }
}

// Filters, applies the limits and reads the accepted files as text.
//   collected  – [{ path, file }] from the picker or a drop
//   existing   – files already staged: [{ path, content, size }]
//   preSkipped – [{ path, reason }] already skipped while collecting
// A newly added file replaces an already-staged file with the same path.
// Resolves to { files: [{ path, content, size }], skipped: [{ reason, count, examples }] }.
export async function loadFiles(collected, existing = [], preSkipped = []) {
  const skipped = [...preSkipped];
  const pool = new Map(existing.map((f) => [f.path, { path: f.path, size: f.size, content: f.content }]));

  for (const { path: rawPath, file } of collected) {
    const path = String(rawPath).replace(/\\/g, '/').replace(/^\/+/, '');
    const reason = skipReasonForPath(path);
    if (reason) {
      skipped.push({ path: reason === 'ignored folder' ? ignoredPrefix(path) : path, reason });
    } else if (file.size === 0) {
      skipped.push({ path, reason: 'empty file' });
    } else if (file.size > LIMITS.MAX_FILE_BYTES) {
      skipped.push({ path, reason: `larger than ${LIMITS.MAX_FILE_BYTES / 1024} KB` });
    } else {
      pool.set(path, { path, size: file.size, file });
    }
  }

  // Choose what fits using sizes only, so we never read files we won't use.
  const selected = [];
  let total = 0;
  for (const item of [...pool.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (selected.length >= LIMITS.MAX_FILES) {
      skipped.push({ path: item.path, reason: `over the ${LIMITS.MAX_FILES}-file limit` });
    } else if (total + item.size > LIMITS.MAX_TOTAL_BYTES) {
      skipped.push({ path: item.path, reason: 'over the total size limit' });
    } else {
      selected.push(item);
      total += item.size;
    }
  }

  const files = [];
  for (const item of selected) {
    if (item.content !== undefined) {
      files.push({ path: item.path, content: item.content, size: item.size });
      continue;
    }
    let text;
    try {
      text = await item.file.text();
    } catch {
      skipped.push({ path: item.path, reason: 'could not be read' });
      continue;
    }
    if (text.includes('\0')) {
      skipped.push({ path: item.path, reason: 'binary or non-text file' });
    } else if (!text.trim()) {
      skipped.push({ path: item.path, reason: 'empty file' });
    } else {
      files.push({ path: item.path, content: text, size: item.size });
    }
  }

  return { files, skipped: groupSkipped(skipped) };
}

// Groups findings by file, worst file first, for the multi-file results view.
const SEVERITY_RANK = { blocking: 0, warning: 1, nitpick: 2 };
export function groupFindingsByFile(findings) {
  const rank = (f) => SEVERITY_RANK[f.severity] ?? 3;
  const byFile = new Map();
  for (const f of findings) {
    const key = f.filePath || '(unknown file)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  return [...byFile.entries()]
    .map(([path, items]) => ({
      path,
      findings: [...items].sort((a, b) => rank(a) - rank(b)),
      worst: Math.min(...items.map(rank)),
    }))
    .sort((a, b) => a.worst - b.worst || b.findings.length - a.findings.length || a.path.localeCompare(b.path));
}
