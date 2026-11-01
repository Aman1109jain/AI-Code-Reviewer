import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Code2,
  Play,
  Github,
  ExternalLink,
  Loader2,
  Upload,
  FileUp,
  FolderUp,
  FileText,
  X,
  Trash2,
  AlertTriangle,
} from 'lucide-react';
import api from '../api.js';
import { useGithub } from '../context/GithubContext.jsx';
import {
  LIMITS,
  collectFromFileList,
  collectFromDrop,
  loadFiles,
  groupFindingsByFile,
  formatBytes,
} from '../utils/uploadFiles.js';

const SEVERITY_ORDER = { blocking: 0, warning: 1, nitpick: 2 };

function FindingCard({ f, showPath = true }) {
  return (
    <div className="finding-card">
      <div className={`finding-card-head ${showPath ? '' : 'no-path'}`}>
        {showPath && <div className="file-path">{f.filePath}</div>}
        <div className="finding-card-tags">
          <span className={`severity-pill ${f.severity}`}>{f.severity}</span>
          {f.category && <span className="category-pill">{f.category}</span>}
        </div>
      </div>
      <p className="issue">{f.issue}</p>
      <p className="suggestion">{f.suggestion}</p>
    </div>
  );
}

// "Skipped 12 items: 10 ignored folder (node_modules/) · 2 binary files …"
function SkippedNote({ groups, title }) {
  if (!groups || !groups.length) return null;
  const total = groups.reduce((n, g) => n + g.count, 0);
  return (
    <div className="notice">
      <strong>{title || `Skipped ${total} item${total === 1 ? '' : 's'}`}</strong>
      <ul>
        {groups.map((g) => (
          <li key={g.reason}>
            <b>{g.count}</b> {g.reason}
            <span className="muted-inline">
              {' '}— {g.examples.join(', ')}
              {g.count > g.examples.length ? ', …' : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function QuickReview({ onOpenReview }) {
  const [mode, setMode] = useState('paste'); // 'paste' | 'upload'

  // paste mode
  const [code, setCode] = useState('');
  const [fileName, setFileName] = useState('snippet.py');

  // upload mode
  const [uploaded, setUploaded] = useState([]); // [{ path, content, size }]
  const [uploadSkipped, setUploadSkipped] = useState([]); // grouped skip reasons
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null); // { reviewId, findings, overallScore, files, skipped, warnings }

  const [showPrForm, setShowPrForm] = useState(false);
  const [prState, setPrState] = useState({
    owner: '',
    repo: '',
    branchName: `quick-check-${Date.now()}`,
    targetDir: '',
    commitMessage: '',
    prTitle: '',
    prBody: '',
  });
  const [prSubmitting, setPrSubmitting] = useState(false);
  const [prResult, setPrResult] = useState(null);
  const [prError, setPrError] = useState(null);

  const { connected, repos, connect } = useGithub();

  // A folder picker needs the (non-standard) webkitdirectory attribute. The
  // input only exists while the Upload tab is open, so the attribute is set by a
  // callback ref at the moment the element is created (setting it directly also
  // avoids React's handling of unknown attributes).
  const setFolderInput = useCallback((el) => {
    folderInputRef.current = el;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, []);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return undefined;
    }
    const startedAt = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  const totalBytes = useMemo(() => uploaded.reduce((n, f) => n + f.size, 0), [uploaded]);
  const canRun = mode === 'paste' ? !!code.trim() : uploaded.length > 0;

  // ---- upload handlers ---------------------------------------------------
  const addCollected = async (collected, preSkipped = []) => {
    setLoadingFiles(true);
    try {
      const out = await loadFiles(collected, uploaded, preSkipped);
      setUploaded(out.files);
      setUploadSkipped(out.skipped);
    } catch (err) {
      setError(`Couldn't read those files: ${err.message}`);
    } finally {
      setLoadingFiles(false);
    }
  };

  const onPick = (e) => {
    const list = Array.from(e.target.files || []);
    e.target.value = ''; // lets the same folder be picked again later
    if (list.length) addCollected(collectFromFileList(list));
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    // collectFromDrop grabs what it needs from the event synchronously.
    const { collected, skipped } = await collectFromDrop(e.dataTransfer);
    if (collected.length || skipped.length) addCollected(collected, skipped);
  };

  const removeFile = (path) => setUploaded((list) => list.filter((f) => f.path !== path));
  const clearFiles = () => {
    setUploaded([]);
    setUploadSkipped([]);
  };

  // ---- review ------------------------------------------------------------
  const runReview = async () => {
    if (!canRun) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setPrResult(null);
    setShowPrForm(false);
    try {
      const data =
        mode === 'paste'
          ? await api.runQuickReview({ code, fileName })
          : await api.runQuickReview({ files: uploaded.map(({ path, content }) => ({ path, content })) });
      setResult(data);

      const label = data.files && data.files.length === 1 ? data.files[0] : `${data.fileCount} files`;
      setPrState((s) => ({ ...s, commitMessage: `Add ${label}`, prTitle: `Add ${label}` }));
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setRunning(false);
    }
  };

  const submitPr = async () => {
    if (!prState.owner || !prState.repo || !prState.branchName) return;
    setPrSubmitting(true);
    setPrError(null);
    try {
      const data = await api.createPrFromReview(result.reviewId, prState);
      setPrResult(data);
      // a branch name can only be used once — get a fresh one for next time
      setPrState((s) => ({ ...s, branchName: `quick-check-${Date.now()}` }));
    } catch (err) {
      setPrError(err.response?.data?.error || err.message);
    } finally {
      setPrSubmitting(false);
    }
  };

  // ---- results view ------------------------------------------------------
  const sortedFindings = useMemo(
    () =>
      result?.findings
        ? [...result.findings].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
        : [],
    [result]
  );
  const multiFile = (result?.files?.length || 0) > 1;
  const groups = useMemo(() => (multiFile ? groupFindingsByFile(sortedFindings) : []), [multiFile, sortedFindings]);
  const cleanFiles = useMemo(() => {
    if (!multiFile) return [];
    const withFindings = new Set(groups.map((g) => g.path));
    return result.files.filter((p) => !withFindings.has(p));
  }, [multiFile, groups, result]);

  const scoreTone = result ? (result.overallScore >= 80 ? 'good' : result.overallScore >= 50 ? 'mid' : 'bad') : 'good';

  return (
    <div className="quick-review">
      <div className="panel-header-plain">
        <h2><Code2 size={20} /> Quick Check</h2>
        <p>Paste code, or upload files and whole folders, and get an instant review — no GitHub PR needed.</p>
      </div>

      {!connected && (
        <div className="adm-notice adm-notice-info" role="status">
          Connect your GitHub account to run reviews (your results are private to you).{' '}
          <button className="adm-link" onClick={connect}>Connect GitHub</button>
        </div>
      )}

      <div className="panel quick-review-editor">
        <div className="quick-review-toolbar">
          <div className="detail-tabs input-tabs">
            <button className={`detail-tab ${mode === 'paste' ? 'is-active' : ''}`} onClick={() => setMode('paste')}>
              <Code2 size={14} /> Paste code
            </button>
            <button className={`detail-tab ${mode === 'upload' ? 'is-active' : ''}`} onClick={() => setMode('upload')}>
              <Upload size={14} /> Upload files / folder
              {uploaded.length > 0 && <span className="tab-count">{uploaded.length}</span>}
            </button>
          </div>
          <button className="btn-primary" onClick={runReview} disabled={running || !canRun || !connected}>
            {running ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
            {running ? `Reviewing… ${elapsed}s` : 'Run review'}
          </button>
        </div>

        {mode === 'paste' && (
          <>
            <input
              className="filename-input"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="filename.py"
            />
            <textarea
              className="code-textarea"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste or write your code here…"
              spellCheck={false}
            />
          </>
        )}

        {mode === 'upload' && (
          <>
            <div
              className={`drop-zone ${dragOver ? 'is-over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              {loadingFiles ? <Loader2 size={26} className="spin" /> : <Upload size={26} />}
              <p className="drop-title">{loadingFiles ? 'Reading files…' : 'Drag & drop files or a folder here'}</p>
              <p className="drop-hint">
                Up to {LIMITS.MAX_FILES} files · {LIMITS.MAX_FILE_BYTES / 1024} KB per file · {LIMITS.MAX_TOTAL_BYTES / 1024} KB in
                total. Folders like node_modules and .git, lock files, binaries and .env / key files are skipped automatically.
              </p>
              <div className="drop-actions">
                <button className="btn-ghost-sm" onClick={() => fileInputRef.current?.click()}>
                  <FileUp size={14} /> Choose files
                </button>
                <button className="btn-ghost-sm" onClick={() => folderInputRef.current?.click()}>
                  <FolderUp size={14} /> Choose folder
                </button>
              </div>
              <input ref={fileInputRef} type="file" multiple hidden onChange={onPick} />
              <input ref={setFolderInput} type="file" multiple hidden onChange={onPick} />
            </div>

            {uploaded.length > 0 && (
              <div className="file-list">
                <div className="file-list-head">
                  <span>
                    {uploaded.length} file{uploaded.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                  </span>
                  <button className="link-btn" onClick={clearFiles}>
                    <Trash2 size={13} /> Clear all
                  </button>
                </div>
                <ul>
                  {uploaded.map((f) => (
                    <li key={f.path}>
                      <FileText size={13} />
                      <span className="file-list-path" title={f.path}>{f.path}</span>
                      <span className="file-list-size">{formatBytes(f.size)}</span>
                      <button className="icon-btn-sm" onClick={() => removeFile(f.path)} aria-label={`Remove ${f.path}`}>
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <SkippedNote groups={uploadSkipped} />
          </>
        )}

        {running && mode === 'upload' && uploaded.length > 1 && (
          <div className="notice">
            Reviewing {uploaded.length} files — larger uploads are checked in batches and can take a minute or two.
          </div>
        )}
      </div>

      {error && <div className="state-msg state-error">{error}</div>}

      {result && (
        <div className="panel">
          <div className="panel-header">
            <h3>Results{multiFile ? ` — ${result.fileCount} files` : ''}</h3>
            <span className={`score-badge tone-${scoreTone}`}>Score {result.overallScore}</span>
          </div>

          {result.warnings && result.warnings.length > 0 && (
            <div className="notice notice-warn">
              <AlertTriangle size={15} />
              <div>{result.warnings.map((w) => <p key={w}>{w}</p>)}</div>
            </div>
          )}
          <SkippedNote groups={result.skipped} title="The server also skipped:" />

          {sortedFindings.length === 0 && <div className="state-msg">No issues found. 🎉</div>}

          {!multiFile && sortedFindings.map((f, i) => <FindingCard f={f} key={i} />)}

          {multiFile &&
            groups.map((g) => (
              <div className="file-group" key={g.path}>
                <div className="file-group-head">
                  <span className="file-path">{g.path}</span>
                  <span className="finding-count has-findings">{g.findings.length}</span>
                </div>
                {g.findings.map((f, i) => <FindingCard f={f} showPath={false} key={i} />)}
              </div>
            ))}

          {multiFile && cleanFiles.length > 0 && (
            <div className="clean-files">
              ✓ {cleanFiles.length} file{cleanFiles.length === 1 ? '' : 's'} with no findings:{' '}
              <span className="muted-inline">
                {cleanFiles.slice(0, 8).join(', ')}
                {cleanFiles.length > 8 ? `, and ${cleanFiles.length - 8} more` : ''}
              </span>
            </div>
          )}

          <div className="quick-review-footer">
            <button className="btn-ghost-sm" onClick={() => onOpenReview(result.reviewId)}>
              View as full review
            </button>
            {connected ? (
              <button className="btn-primary" onClick={() => setShowPrForm((s) => !s)}>
                <Github size={15} /> {showPrForm ? 'Hide' : 'Push to GitHub / Create PR'}
              </button>
            ) : (
              <button className="btn-primary" onClick={connect} title="Connect GitHub to push this code as a PR">
                <Github size={15} /> Connect GitHub to create a PR
              </button>
            )}
          </div>
        </div>
      )}

      {showPrForm && result && (
        <div className="panel pr-form">
          <div className="panel-header">
            <h3>Create pull request</h3>
            <span className="panel-header-hint">
              {result.fileCount} file{result.fileCount === 1 ? '' : 's'} will be added in a single commit
            </span>
          </div>
          <div className="pr-form-grid">
            <label>
              Repo
              <select
                value={prState.owner && prState.repo ? `${prState.owner}/${prState.repo}` : ''}
                onChange={(e) => {
                  const [owner, repo] = e.target.value.split('/');
                  setPrState((s) => ({ ...s, owner, repo }));
                }}
              >
                <option value="">Select a repo…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            </label>
            <label>
              Branch name
              <input
                value={prState.branchName}
                onChange={(e) => setPrState((s) => ({ ...s, branchName: e.target.value }))}
              />
            </label>
            <label>
              Folder in repo (optional)
              <input
                value={prState.targetDir}
                placeholder="e.g. imports — empty = repo root"
                onChange={(e) => setPrState((s) => ({ ...s, targetDir: e.target.value }))}
              />
            </label>
            <label>
              Commit message
              <input
                value={prState.commitMessage}
                onChange={(e) => setPrState((s) => ({ ...s, commitMessage: e.target.value }))}
              />
            </label>
            <label className="pr-form-full">
              PR title
              <input
                value={prState.prTitle}
                onChange={(e) => setPrState((s) => ({ ...s, prTitle: e.target.value }))}
              />
            </label>
            <label className="pr-form-full">
              PR description
              <textarea
                rows={3}
                value={prState.prBody}
                onChange={(e) => setPrState((s) => ({ ...s, prBody: e.target.value }))}
              />
            </label>
          </div>

          {prError && <div className="state-msg state-error">{prError}</div>}
          {prResult && (
            <div className="state-msg">
              PR opened —{' '}
              <a href={prResult.prUrl} target="_blank" rel="noreferrer">
                #{prResult.prNumber} <ExternalLink size={12} />
              </a>
            </div>
          )}

          <button
            className="btn-primary"
            onClick={submitPr}
            disabled={prSubmitting || !prState.owner || !prState.repo}
          >
            {prSubmitting ? <Loader2 size={15} className="spin" /> : <Github size={15} />}
            {prSubmitting ? 'Creating…' : 'Create PR'}
          </button>
        </div>
      )}
    </div>
  );
}
