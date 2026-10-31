function mergeFindings(staticFindings, llmFindings) {
  return [...staticFindings, ...llmFindings];
}

// A simple 0-100 quality score derived from the findings themselves —
// no separate model call needed. Blocking issues cost the most, nitpicks
// the least, floored at 0.
const PENALTY = { blocking: 15, warning: 7, nitpick: 2 };

function computeOverallScore(findings) {
  const penalty = findings.reduce((sum, f) => sum + (PENALTY[f.severity] ?? 5), 0);
  return Math.max(0, 100 - penalty);
}

module.exports = { mergeFindings, computeOverallScore };
