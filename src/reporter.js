// Builds a Markdown report string from a run's results.
// Used both by GET /api/report and reusable for file writes.

function pct(n, d) {
  return d === 0 ? '0.0' : ((n / d) * 100).toFixed(1);
}

export function buildMarkdownReport(results) {
  const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const total = results.length;

  const scored = results.filter((r) => r.status !== 'ERROR');
  const accuracyMatches = results.filter((r) => r.accuracyMatch === true).length;
  const accuracyScored = results.filter((r) => r.accuracyMatch !== null && r.accuracyMatch !== undefined).length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const latencies = scored.map((r) => r.latencyMs).filter((l) => typeof l === 'number');
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  const lines = [];
  lines.push(`# LLM Evaluation Report — ${date}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- **Total cases:** ${total}`);
  lines.push(`- **Pass rate:** ${pct(passed, total)}% (${passed}/${total})`);
  lines.push(`- **Accuracy (vs expected):** ${pct(accuracyMatches, accuracyScored || total)}% (${accuracyMatches}/${accuracyScored || total})`);
  lines.push(`- **Avg latency:** ${avgLatency} ms`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| ID | Input | Category | Expected | Actual | Confidence | Status | Latency (ms) |');
  lines.push('|----|-------|----------|----------|--------|------------|--------|--------------|');
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${r.input} | ${r.category ?? '—'} | ${r.expected} | ${r.actual ?? '—'} | ${r.confidence ?? '—'} | ${r.status} | ${r.latencyMs ?? '—'} |`
    );
  }
  lines.push('');

  const errorCases = results.filter(
    (r) => r.status === 'ERROR' || (r.checks || []).some((c) => !c.passed && (c.name === 'JSON validity' || c.name === 'Schema'))
  );
  lines.push('## Error Log (JSON/schema failures & API errors)');
  lines.push('');
  if (errorCases.length === 0) {
    lines.push('_No errors._');
  } else {
    for (const r of errorCases) {
      const failedCheck = (r.checks || []).find((c) => !c.passed);
      const detail = r.status === 'ERROR' ? r.error : failedCheck ? `${failedCheck.name}: ${failedCheck.detail}` : 'Unknown';
      lines.push(`- **Case ${r.id}** (\`${r.input}\`): ${detail}`);
    }
  }
  lines.push('');

  const hallucinated = results.filter((r) => (r.hallucinatedSnippets || []).length > 0);
  lines.push('## Hallucination Log');
  lines.push('');
  if (hallucinated.length === 0) {
    lines.push('_No hallucinations flagged._');
  } else {
    for (const r of hallucinated) {
      const snippets = r.hallucinatedSnippets.map((f) => `\`${f.token}\` (${f.reason})`).join(', ');
      lines.push(`- **Case ${r.id}** (\`${r.input}\`): ${snippets}`);
      lines.push(`  - Reasoning: "${r.reasoning}"`);
    }
  }
  lines.push('');

  return lines.join('\n');
}
