import 'dotenv/config';
import express from 'express';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluateTestCase, validateResponse } from './evaluator.js';
import { buildMarkdownReport } from './reporter.js';
import { generateTestCases } from './generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DELAY_BETWEEN_CALLS_MS = 500;

export const app = express();
app.use(express.static(path.join(ROOT, 'public')));
app.use(express.json());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/api/run', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not set. Add it to your .env file.' });
  }

  // ?fixed=1 loads the static suite from data/test-cases.json (reproducible
  // runs); the default is a freshly randomized suite each run.
  let testCases;
  if (req.query.fixed === '1') {
    try {
      const rawFile = await readFile(path.join(ROOT, 'data', 'test-cases.json'), 'utf8');
      testCases = JSON.parse(rawFile);
    } catch (err) {
      return res.status(500).json({ error: `Failed to load test cases: ${err.message}` });
    }
  } else {
    testCases = generateTestCases();
  }

  const results = [];
  for (const testCase of testCases) {
    const base = {
      id: testCase.id,
      input: testCase.inputText,
      expected: testCase.expectedClassification,
      category: testCase.category ?? 'General'
    };
    try {
      const { raw, latencyMs } = await evaluateTestCase(testCase);
      const { status, checks, parsed, accuracyMatch, hallucinatedSnippets } = validateResponse(testCase, raw);
      results.push({
        ...base,
        actual: parsed?.classification ?? null,
        confidence: parsed?.confidence ?? null,
        reasoning: parsed?.reasoning ?? null,
        raw,
        checks,
        status,
        accuracyMatch,
        hallucinatedSnippets,
        latencyMs
      });
    } catch (err) {
      // A failed API call for one case shouldn't crash the run.
      console.error(`[eval] Case ${testCase.id} errored: ${err.message}`);
      results.push({
        ...base,
        actual: null,
        confidence: null,
        reasoning: null,
        raw: null,
        checks: [],
        status: 'ERROR',
        accuracyMatch: null,
        hallucinatedSnippets: [],
        latencyMs: null,
        error: err.message
      });
    }
    await sleep(DELAY_BETWEEN_CALLS_MS);
  }

  res.status(200).json(results);
});

app.post('/api/test-single', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY is not set. Add it to your .env file.' });
  }

  const inputText = String(req.body?.inputText ?? '').trim();
  const taskType = req.body?.taskType === 'structure' ? 'structure' : 'classification';
  if (!inputText) {
    return res.status(400).json({ error: 'inputText is required.' });
  }

  const testCase = { id: 'manual', inputText, expectedClassification: null, taskType };
  const base = { id: 'manual', input: inputText, expected: null, category: 'Manual', taskType };

  try {
    const { raw, latencyMs } = await evaluateTestCase(testCase);
    const { status, checks, parsed, hallucinatedSnippets } = validateResponse(testCase, raw);
    return res.status(200).json({
      ...base,
      actual: parsed?.classification ?? null,
      confidence: parsed?.confidence ?? null,
      reasoning: parsed?.reasoning ?? null,
      raw,
      checks,
      status,
      hallucinatedSnippets,
      latencyMs
    });
  } catch (err) {
    return res.status(200).json({
      ...base,
      actual: null,
      confidence: null,
      reasoning: null,
      raw: null,
      checks: [],
      status: 'ERROR',
      hallucinatedSnippets: [],
      latencyMs: null,
      error: err.message
    });
  }
});

// Stateless by design: the client sends back the results from its last
// /api/run response and this route only formats them. That keeps report
// generation safe on serverless platforms (e.g. Vercel), where there's no
// guarantee the same instance handles both requests.
app.post('/api/report', (req, res) => {
  const results = req.body?.results;
  if (!Array.isArray(results) || results.length === 0) {
    return res.status(400).json({ error: 'No results provided. Run an evaluation first.' });
  }
  const markdown = buildMarkdownReport(results);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="eval-report.md"');
  res.send(markdown);
});

export default app;
