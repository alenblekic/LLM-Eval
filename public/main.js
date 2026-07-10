const appTitle = document.getElementById('app-title');
const runBtn = document.getElementById('run-btn');
const downloadBtn = document.getElementById('download-btn');
const statusLine = document.getElementById('status');
const summaryCards = document.getElementById('summary-cards');
const resultsSection = document.getElementById('results-section');
const resultsBody = document.getElementById('results-body');
const errorBanner = document.getElementById('error-banner');
let lastResults = null;
const manualInput = document.getElementById('manual-input');
const manualTaskType = document.getElementById('manual-tasktype');
const manualRunBtn = document.getElementById('manual-run-btn');
const manualResult = document.getElementById('manual-result');

function setStatus(text) {
  statusLine.textContent = text;
}

function showError(message) {
  errorBanner.textContent = message;
  errorBanner.hidden = false;
}

function badge(status) {
  const cls = status === 'PASS' ? 'badge-pass' : status === 'FAIL' ? 'badge-fail' : 'badge-error';
  return `<span class="badge ${cls}">${status}</span>`;
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '—' : String(value);
  return div.innerHTML;
}

function renderSummary(results) {
  const total = results.length;
  const scored = results.filter((r) => r.accuracyMatch !== null && r.accuracyMatch !== undefined);
  const matches = results.filter((r) => r.accuracyMatch === true).length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const hallucinations = results.filter((r) => (r.hallucinatedSnippets || []).length > 0).length;
  const latencies = results.map((r) => r.latencyMs).filter((l) => typeof l === 'number');
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  document.getElementById('card-accuracy').textContent =
    scored.length ? `${((matches / scored.length) * 100).toFixed(0)}%` : '—';
  document.getElementById('card-passrate').textContent = `${((passed / total) * 100).toFixed(0)}%`;
  document.getElementById('card-hallucinations').textContent = hallucinations;
  document.getElementById('card-latency').textContent = `${avgLatency} ms`;
  summaryCards.hidden = false;
}

function renderDetail(r) {
  let html = '';

  html += `<div class="detail-block"><h4>Reasoning</h4><p>${esc(r.reasoning ?? r.error ?? 'No reasoning available')}</p></div>`;

  if (r.checks && r.checks.length) {
    const items = r.checks
      .map((c) => `<li class="${c.passed ? 'check-passed' : 'check-failed'}">${esc(c.name)}: ${esc(c.detail)}</li>`)
      .join('');
    html += `<div class="detail-block"><h4>Checks</h4><ul class="check-list">${items}</ul></div>`;
  }

  if ((r.hallucinatedSnippets || []).length) {
    const items = r.hallucinatedSnippets
      .map((f) => `<li class="check-failed">"${esc(f.token)}" — ${esc(f.reason)}</li>`)
      .join('');
    html += `<div class="detail-block"><h4>Hallucinated Snippets</h4><ul class="check-list">${items}</ul></div>`;
  }

  if (r.status === 'ERROR' && r.error) {
    html += `<div class="detail-block"><h4>Error</h4><p>${esc(r.error)}</p></div>`;
  }

  return html;
}

function renderTable(results) {
  resultsBody.innerHTML = '';

  for (const r of results) {
    const row = document.createElement('tr');
    row.className = 'result-row';
    row.innerHTML = `
      <td>${esc(r.id)}</td>
      <td>${esc(r.input)}</td>
      <td>${esc(r.category)}</td>
      <td>${esc(r.expected)}</td>
      <td>${esc(r.actual)}</td>
      <td>${r.confidence == null ? '—' : esc(r.confidence)}</td>
      <td>${badge(r.status)}</td>
    `;

    const detailRow = document.createElement('tr');
    detailRow.className = 'detail-row';
    detailRow.hidden = true;
    detailRow.innerHTML = `<td colspan="7">${renderDetail(r)}</td>`;

    row.addEventListener('click', () => {
      detailRow.hidden = !detailRow.hidden;
    });

    resultsBody.appendChild(row);
    resultsBody.appendChild(detailRow);
  }

  resultsSection.hidden = false;
}

runBtn.addEventListener('click', async () => {
  runBtn.disabled = true;
  downloadBtn.disabled = true;
  errorBanner.hidden = true;
  setStatus('Running evaluation…');
  const started = Date.now();

  try {
    const res = await fetch('/api/run', { method: 'POST' });
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Server returned ${res.status}`);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const passed = data.filter((r) => r.status === 'PASS').length;
    setStatus(`Done — ${passed}/${data.length} passed in ${seconds}s`);
    renderSummary(data);
    renderTable(data);
    lastResults = data;
    downloadBtn.disabled = false;
  } catch (err) {
    setStatus('Failed');
    showError(`Run failed: ${err.message}`);
  } finally {
    runBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', async () => {
  if (!lastResults) return;

  downloadBtn.disabled = true;
  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ results: lastResults })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Server returned ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eval-report.md';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(`Report download failed: ${err.message}`);
  } finally {
    downloadBtn.disabled = false;
  }
});

appTitle.addEventListener('click', () => {
  window.location.reload();
});

async function runManualTest() {
  const inputText = manualInput.value.trim();
  if (!inputText) {
    manualInput.focus();
    return;
  }

  manualRunBtn.disabled = true;
  manualRunBtn.textContent = 'Testing…';
  manualResult.hidden = false;
  manualResult.innerHTML = '<p class="manual-status">Calling the model…</p>';

  try {
    const res = await fetch('/api/test-single', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputText, taskType: manualTaskType.value })
    });
    const r = await res.json();

    if (!res.ok) {
      throw new Error(r.error || `Server returned ${res.status}`);
    }

    manualResult.innerHTML = `
      <div class="manual-result-header">
        <span>${esc(r.actual)}${r.confidence != null ? ` &middot; confidence ${esc(r.confidence)}` : ''}</span>
        ${badge(r.status)}
      </div>
      ${renderDetail(r)}
    `;
  } catch (err) {
    manualResult.innerHTML = `<p class="manual-status manual-status-error">Test failed: ${esc(err.message)}</p>`;
  } finally {
    manualRunBtn.disabled = false;
    manualRunBtn.textContent = 'Test Input';
  }
}

manualRunBtn.addEventListener('click', runManualTest);
manualInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runManualTest();
});
