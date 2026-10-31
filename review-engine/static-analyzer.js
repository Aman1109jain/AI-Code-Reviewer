const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// A hung Semgrep (e.g. a slow rule-registry download) must not hang a review.
const SEMGREP_TIMEOUT_MS = 120000;
let warnedMissing = false;

// Runs Semgrep ONCE over several files. (It used to be one Semgrep process per
// file, each re-fetching rules over the network — far too slow for folders.)
// Resolves to Semgrep's raw result objects, or [] if it can't run.
function runSemgrep(cwd, targets) {
  return new Promise((resolve) => {
    execFile(
      'semgrep',
      ['--config', 'auto', '--json', '--no-git-ignore', '--quiet', ...targets],
      { cwd, maxBuffer: 1024 * 1024 * 10, timeout: SEMGREP_TIMEOUT_MS },
      (error, stdout) => {
        if (!stdout) {
          if (error && error.code === 'ENOENT') {
            if (!warnedMissing) {
              warnedMissing = true;
              console.error('Semgrep is not installed (or not on PATH) - skipping static analysis. Install it with: pip install semgrep');
            }
          } else if (error && error.killed) {
            console.error(`Semgrep timed out after ${SEMGREP_TIMEOUT_MS / 1000}s - skipping static analysis for this run.`);
          } else {
            console.error('Semgrep produced no output:', error && error.message);
          }
          return resolve([]);
        }
        try {
          resolve(JSON.parse(stdout).results || []);
        } catch (parseErr) {
          console.error('Failed to parse Semgrep JSON output:', parseErr.message);
          resolve([]);
        }
      }
    );
  });
}

function splitDiffByFile(diff) {
  const fileBlocks = [];
  const lines = diff.split('\n');
  let currentFile = null;
  let currentLines = [];

  for (const line of lines) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) {
      if (currentFile) {
        fileBlocks.push({ fileName: currentFile, addedLines: currentLines.join('\n') });
      }
      currentFile = match[2];
      currentLines = [];
    } else if (line.startsWith('+') && !line.startsWith('+++ ')) {
      // "+++ " is the file header; a code line like "++i;" must still count.
      currentLines.push(line.slice(1));
    }
  }
  if (currentFile) {
    fileBlocks.push({ fileName: currentFile, addedLines: currentLines.join('\n') });
  }

  return fileBlocks;
}

function toFinding(r, originalName) {
  const extra = r.extra || {};
  const autofix = extra.fix;
  const ruleLink = (extra.metadata && extra.metadata.source) || `https://semgrep.dev/r/${r.check_id}`;
  return {
    filePath: originalName,
    severity: extra.severity === 'ERROR' ? 'blocking' : 'warning',
    category: 'security',
    issue: extra.message || 'Issue detected by static analysis.',
    suggestion: autofix ? `Suggested fix: ${autofix}` : `Learn more: ${ruleLink}`,
  };
}

async function runStaticAnalysis(diff) {
  const blocks = splitDiffByFile(diff).filter((b) => b.addedLines.trim());
  if (!blocks.length) return [];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'semgrep-check-'));
  try {
    // Files are written under neutral temp names (keeping only the extension so
    // Semgrep picks the right language) — this sidesteps odd characters in real
    // paths, and maps each result straight back to the original path.
    const nameMap = new Map();
    blocks.forEach((b, i) => {
      const rawExt = path.extname(b.fileName);
      const ext = /^\.[A-Za-z0-9_+-]{1,10}$/.test(rawExt) ? rawExt : '.txt';
      const tempName = `file-${i}${ext}`;
      fs.writeFileSync(path.join(dir, tempName), b.addedLines);
      nameMap.set(tempName, b.fileName);
    });

    const results = await runSemgrep(dir, [...nameMap.keys()]);

    return results.map((r) => {
      const base = path.basename(String(r.path || '').replace(/\\/g, '/'));
      return toFinding(r, nameMap.get(base) || r.path);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { runStaticAnalysis };
