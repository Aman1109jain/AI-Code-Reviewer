// Renders a raw unified diff with git-style coloring: additions green,
// removals rose, hunk headers violet, file headers muted+bold.
export default function DiffViewer({ diff }) {
  if (!diff) {
    return <div className="state-msg">No diff was stored for this review.</div>;
  }

  const lines = diff.split('\n');

  const classify = (line) => {
    if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
    if (line.startsWith('@@')) return 'diff-hunk';
    if (line.startsWith('diff --git') || line.startsWith('index ')) return 'diff-meta';
    if (line.startsWith('+')) return 'diff-add';
    if (line.startsWith('-')) return 'diff-remove';
    return 'diff-context';
  };

  return (
    <div className="diff-viewer">
      <pre>
        {lines.map((line, i) => (
          <div key={i} className={`diff-line ${classify(line)}`}>
            <span className="diff-gutter">{i + 1}</span>
            <span className="diff-text">{line || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
