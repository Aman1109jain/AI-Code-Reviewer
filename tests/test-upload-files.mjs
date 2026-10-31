// Run with: npm test   (or: node tests/test-upload-files.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS,
  skipReasonForPath,
  groupSkipped,
  collectFromFileList,
  collectFromDrop,
  loadFiles,
  groupFindingsByFile,
  formatBytes,
} from '../dashboard/client/src/utils/uploadFiles.js';

// Minimal stand-ins for the browser's File / FileSystemEntry objects.
const fakeFile = (content, extra = {}) => ({
  size: Buffer.byteLength(content),
  text: async () => content,
  ...extra,
});
const fileEntry = (name, fullPath, content) => ({
  isFile: true,
  isDirectory: false,
  name,
  fullPath,
  file: (ok) => ok(fakeFile(content)),
});
const dirEntry = (name, fullPath, children) => ({
  isFile: false,
  isDirectory: true,
  name,
  fullPath,
  createReader() {
    let served = false; // real readers hand results back in chunks, then []
    return { readEntries: (ok) => { const out = served ? [] : children; served = true; ok(out); } };
  },
});

test('skipReasonForPath flags junk but keeps real code', () => {
  assert.equal(skipReasonForPath('app/node_modules/lodash/index.js'), 'ignored folder');
  assert.equal(skipReasonForPath('.git/config'), 'ignored folder');
  assert.equal(skipReasonForPath('package-lock.json'), 'lock / generated file');
  assert.equal(skipReasonForPath('static/app.min.js'), 'minified / bundled file');
  assert.equal(skipReasonForPath('assets/logo.PNG'), 'binary or non-text file');
  assert.match(skipReasonForPath('config/.env.local'), /never sent to the AI/);
  assert.match(skipReasonForPath('deploy/server.pem'), /never sent to the AI/);
  assert.equal(skipReasonForPath('src/app.py'), null);
  assert.equal(skipReasonForPath('Dockerfile'), null);
  assert.equal(skipReasonForPath('src/build_utils.py'), null); // "build" only ignored as a folder name
  assert.equal(skipReasonForPath('docs/environment.md'), null);
});

test('formatBytes', () => {
  assert.equal(formatBytes(500), '500 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(150 * 1024), '150 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
});

test('collectFromFileList uses the folder-relative path when present', () => {
  const out = collectFromFileList([
    fakeFile('a', { name: 'a.py', webkitRelativePath: 'proj/src/a.py' }),
    fakeFile('b', { name: 'b.py', webkitRelativePath: '' }),
  ]);
  assert.deepEqual(out.map((o) => o.path), ['proj/src/a.py', 'b.py']);
});

test('loadFiles filters, reads text and groups what it skipped', async () => {
  const collected = [
    { path: 'proj/src/a.py', file: fakeFile('print(1)\n') },
    { path: 'proj/README.md', file: fakeFile('# hi') },
    { path: 'proj/node_modules/x/index.js', file: fakeFile('x') },
    { path: 'proj/node_modules/y/index.js', file: fakeFile('y') },
    { path: 'proj/logo.png', file: fakeFile('png') },
    { path: 'proj/.env', file: fakeFile('SECRET=1') },
    { path: 'proj/empty.py', file: fakeFile('') },
    { path: 'proj/blank.py', file: fakeFile('   \n') },
    { path: 'proj/data.txt', file: fakeFile('a\0b') },
    { path: 'proj/huge.js', file: { size: LIMITS.MAX_FILE_BYTES + 1, text: async () => 'x' } },
  ];
  const { files, skipped } = await loadFiles(collected);
  assert.deepEqual(files.map((f) => f.path), ['proj/README.md', 'proj/src/a.py']);
  assert.equal(files[1].content, 'print(1)\n');
  const byReason = Object.fromEntries(skipped.map((s) => [s.reason, s]));
  assert.equal(byReason['ignored folder'].count, 2);
  assert.deepEqual(byReason['ignored folder'].examples, ['proj/node_modules/']); // one tidy example, not 2 files
  assert.equal(byReason['empty file'].count, 2);
  assert.equal(byReason['binary or non-text file'].count, 2); // png + NUL byte
  assert.ok(byReason['larger than 150 KB']);
  assert.ok(byReason['environment / key file (never sent to the AI)']);
});

test('loadFiles enforces the file-count and total-size limits without reading skipped files', async () => {
  let reads = 0;
  const countedFile = (content) => ({ size: Buffer.byteLength(content), text: async () => { reads++; return content; } });

  const many = Array.from({ length: LIMITS.MAX_FILES + 7 }, (_, i) => ({
    path: `src/f${String(i).padStart(3, '0')}.js`,
    file: countedFile('let a = 1;'),
  }));
  const res = await loadFiles(many);
  assert.equal(res.files.length, LIMITS.MAX_FILES);
  assert.equal(reads, LIMITS.MAX_FILES, 'only accepted files are read');
  assert.equal(res.skipped.find((s) => s.reason.includes('-file limit')).count, 7);

  const fat = 'z'.repeat(LIMITS.MAX_FILE_BYTES);
  const total = await loadFiles([1, 2, 3].map((i) => ({ path: `t${i}.js`, file: fakeFile(fat) })));
  assert.equal(total.files.length, 2);
  assert.ok(total.skipped.some((s) => s.reason === 'over the total size limit'));
});

test('loadFiles merges with already-staged files; same path is replaced', async () => {
  const first = await loadFiles([{ path: 'a.py', file: fakeFile('old') }, { path: 'b.py', file: fakeFile('keep') }]);
  const second = await loadFiles([{ path: 'a.py', file: fakeFile('new') }, { path: 'c.py', file: fakeFile('add') }], first.files);
  assert.deepEqual(second.files.map((f) => [f.path, f.content]), [['a.py', 'new'], ['b.py', 'keep'], ['c.py', 'add']]);
});

test('collectFromDrop walks dropped folders and skips ignored ones', async () => {
  const tree = dirEntry('proj', '/proj', [
    fileEntry('main.py', '/proj/main.py', 'x = 1'),
    dirEntry('src', '/proj/src', [fileEntry('util.py', '/proj/src/util.py', 'y = 2')]),
    dirEntry('node_modules', '/proj/node_modules', [fileEntry('huge.js', '/proj/node_modules/huge.js', 'never read')]),
  ]);
  const dt = { files: [], items: [{ webkitGetAsEntry: () => tree }] };
  const { collected, skipped } = await collectFromDrop(dt);
  assert.deepEqual(collected.map((c) => c.path).sort(), ['proj/main.py', 'proj/src/util.py']);
  assert.deepEqual(skipped, [{ path: 'proj/node_modules/', reason: 'ignored folder' }]);

  // and the result feeds straight into loadFiles
  const loaded = await loadFiles(collected, [], skipped);
  assert.equal(loaded.files.length, 2);
});

test('collectFromDrop falls back to plain files when the entry API is missing', async () => {
  const f = fakeFile('x', { name: 'solo.py' });
  const { collected } = await collectFromDrop({ files: [f], items: [{}] });
  assert.deepEqual(collected.map((c) => c.path), ['solo.py']);
});

test('groupSkipped keeps a few examples per reason', () => {
  const out = groupSkipped(['a', 'b', 'c', 'd', 'e'].map((p) => ({ path: p, reason: 'r' })));
  assert.equal(out[0].count, 5);
  assert.deepEqual(out[0].examples, ['a', 'b', 'c']);
});

test('groupFindingsByFile puts the worst files first', () => {
  const groups = groupFindingsByFile([
    { filePath: 'a.py', severity: 'nitpick' },
    { filePath: 'b.py', severity: 'warning' },
    { filePath: 'b.py', severity: 'blocking' },
    { filePath: 'c.py', severity: 'warning' },
  ]);
  assert.deepEqual(groups.map((g) => g.path), ['b.py', 'c.py', 'a.py']);
  assert.deepEqual(groups[0].findings.map((f) => f.severity), ['blocking', 'warning']);
});
