// Run with: npm test   (or: node tests/test-quick-files.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../utils/quick-files');
const { computeOverallScore } = require('../review-engine/merge-findings');

test('sanitizePath cleans separators and rejects traversal', () => {
  assert.equal(Q.sanitizePath('src\\app\\main.py'), 'src/app/main.py');
  assert.equal(Q.sanitizePath('./src//main.py'), 'src/main.py');
  assert.equal(Q.sanitizePath('/abs/path.js'), 'abs/path.js');
  assert.equal(Q.sanitizePath('../secrets.txt'), null);
  assert.equal(Q.sanitizePath('a/../../b.txt'), null);
  assert.equal(Q.sanitizePath(''), null);
  assert.equal(Q.sanitizePath(42), null);
  assert.equal(Q.sanitizePath('dir b/file.py'), null); // would break "diff --git a/x b/y" parsing
  assert.equal(Q.sanitizePath('x'.repeat(301)), null);
});

test('normalizeFiles keeps good files and groups what it skips', () => {
  const { files, skipped } = Q.normalizeFiles([
    { path: 'src/a.py', content: 'print(1)\n' },
    { path: 'src/a.py', content: 'duplicate' },
    { path: 'logo.png', content: 'not really a png' },
    { path: '.env', content: 'API_KEY=abc' },
    { path: 'config/.env.production', content: 'X=1' },
    { path: 'keys/server.pem', content: '-----BEGIN' },
    { path: 'blank.js', content: '   \n  ' },
    { path: 'bin.dat', content: 'ab\0cd' },
    { path: '../escape.py', content: 'x = 1' },
    { path: 'ok.js', content: 'let x = 1;' },
  ]);
  assert.deepEqual(files.map((f) => f.path), ['src/a.py', 'ok.js']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.reason, s.count]));
  assert.equal(reasons['duplicate path'], 1);
  assert.equal(reasons['binary or non-text file'], 2);
  assert.equal(reasons['environment / key file (never sent to the AI)'], 3);
  assert.equal(reasons['empty file'], 1);
  assert.equal(reasons['unsupported path'], 1);
});

test('normalizeFiles enforces per-file, count and total limits', () => {
  const big = 'x'.repeat(Q.LIMITS.MAX_FILE_BYTES + 1);
  assert.equal(Q.normalizeFiles([{ path: 'big.js', content: big }]).files.length, 0);

  const many = Array.from({ length: Q.LIMITS.MAX_FILES + 5 }, (_, i) => ({ path: `f${i}.js`, content: 'a' }));
  const res = Q.normalizeFiles(many);
  assert.equal(res.files.length, Q.LIMITS.MAX_FILES);
  assert.equal(res.skipped[0].count, 5);

  const chunk = 'y'.repeat(Q.LIMITS.MAX_FILE_BYTES); // 3 of these exceed the 300 KB total
  const total = Q.normalizeFiles([1, 2, 3].map((i) => ({ path: `t${i}.js`, content: chunk })));
  assert.equal(total.files.length, 2);
  assert.equal(total.skipped[0].reason, 'over the total size limit');

  assert.deepEqual(Q.normalizeFiles('nope').files, []);
});

test('buildFileDiff makes a new-file diff with the right line count', () => {
  const diff = Q.buildFileDiff('src/a.py', 'one\r\ntwo\n');
  const lines = diff.split('\n');
  assert.equal(lines[0], 'diff --git a/src/a.py b/src/a.py');
  assert.equal(lines[4], '+++ b/src/a.py');
  assert.equal(lines[5], '@@ -0,0 +1,2 @@');
  assert.deepEqual(lines.slice(6), ['+one', '+two']);
});

test('chunkFiles keeps every file exactly once and respects the size cap', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.js`, content: 'z'.repeat(1000) }));
  const chunks = Q.chunkFiles(files, 3000);
  assert.ok(chunks.length > 1);
  assert.deepEqual(chunks.flat().map((f) => f.path), files.map((f) => f.path));
  const oneBig = Q.chunkFiles([{ path: 'huge.js', content: 'q'.repeat(10000) }], 3000);
  assert.equal(oneBig.length, 1); // a single oversized file still gets reviewed, alone
  assert.deepEqual(Q.chunkFiles([], 3000), []);
});

test('mapWithConcurrency preserves order and never exceeds the limit', async () => {
  let running = 0;
  let peak = 0;
  const out = await Q.mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, 5));
    running--;
    return n * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  assert.equal(peak, 2);
  assert.deepEqual(await Q.mapWithConcurrency([], 3, async (x) => x), []);
});

test('labelForFiles names single files, folders and mixed selections', () => {
  assert.equal(Q.labelForFiles([{ path: 'a.py' }]), 'a.py');
  assert.equal(Q.labelForFiles([{ path: 'app/a.py' }, { path: 'app/src/b.py' }]), 'app/ (2 files)');
  assert.equal(Q.labelForFiles([{ path: 'a.py' }, { path: 'lib/b.py' }]), '2 files');
});

test('canonicalizeFindings maps AI-returned paths back to real uploaded paths', () => {
  const files = [{ path: 'app/src/main.py', content: '' }, { path: 'app/util.py', content: '' }];
  const out = Q.canonicalizeFindings(files, [
    { filePath: 'b/app/src/main.py' },
    { filePath: 'src/main.py' },
    { filePath: 'app/util.py' },
    { filePath: 'something/else.py' },
  ]);
  assert.deepEqual(out.map((f) => f.filePath), ['app/src/main.py', 'app/src/main.py', 'app/util.py', 'something/else.py']);
});

test('computeUploadScore averages per-file scores', () => {
  const one = [{ path: 'a.py', content: '' }];
  const finds = [{ filePath: 'a.py', severity: 'blocking' }, { filePath: 'a.py', severity: 'warning' }];
  assert.equal(Q.computeUploadScore(one, finds), computeOverallScore(finds)); // same as before for one file
  assert.equal(Q.computeUploadScore(one, []), 100);

  const many = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.py`, content: '' }));
  const score = Q.computeUploadScore(many, [{ filePath: 'f0.py', severity: 'blocking' }]);
  assert.equal(score, 99); // one rough file among ten clean ones doesn't tank the folder
});

test('isValidBranchName', () => {
  assert.ok(Q.isValidBranchName('quick-check-123'));
  assert.ok(Q.isValidBranchName('feature/new_upload.v2'));
  for (const bad of ['', 'a b', 'a..b', '/lead', 'trail/', 'x.lock', 'semi;colon', 'new\nline']) {
    assert.equal(Q.isValidBranchName(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});
