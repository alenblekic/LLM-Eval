import Groq from 'groq-sdk';

const MODEL = 'llama-3.3-70b-versatile';
const TEMPERATURE = 0.2;
const REQUEST_TIMEOUT_MS = 30000;

// Two task types share this harness: 'classification' scores search-term
// intent (the original scope), 'structure' scores campaign/ad-group setup
// descriptions for structural issues and missed optimization signals.
const SYSTEM_PROMPTS = {
  classification:
    "You are an Amazon PPC classification assistant. Classify the given search term into exactly one of: " +
    "'High Intent', 'Low Intent', 'Brand', 'Off-Topic'. Respond with a JSON object containing " +
    "'classification' (string), 'confidence' (number 0–1), and 'reasoning' (string). " +
    "Do not include any text outside the JSON object.",
  structure:
    "You are an Amazon PPC campaign structure auditor. You will be given a short description of a campaign " +
    "or ad group setup (keywords, match types, bids, budgets, or search term report data). Classify it into " +
    "exactly one of: 'Well-Structured', 'Needs Fix', 'Missing Insight'. Use 'Needs Fix' for structural problems " +
    "(duplicate keywords across ad groups, overly broad single ad groups, mismatched bid strategy). Use " +
    "'Missing Insight' when the data shows a signal (trend, negative keyword gap, wasted spend) that should " +
    "have been acted on but wasn't. Respond with a JSON object containing 'classification' (string), " +
    "'confidence' (number 0–1), and 'reasoning' (string). Do not include any text outside the JSON object."
};

const ALLOWED_CLASSIFICATIONS_BY_TYPE = {
  classification: ['High Intent', 'Low Intent', 'Brand', 'Off-Topic'],
  structure: ['Well-Structured', 'Needs Fix', 'Missing Insight']
};

const taskTypeOf = (testCase) => testCase.taskType || 'classification';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'at', 'by', 'for',
  'from', 'in', 'into', 'of', 'on', 'or', 'and', 'to', 'with', 'not', 'no',
  'so', 'such', 'which', 'who', 'whom', 'what', 'when', 'where', 'why', 'how',
  'term', 'terms', 'search', 'query', 'user', 'intent', 'high', 'low', 'brand',
  'off', 'topic', 'classification', 'classified', 'classify', 'because',
  'indicates', 'indicating', 'suggests', 'suggesting', 'likely', 'specific',
  'product', 'products', 'shopping', 'purchase', 'buy', 'buying', 'looking',
  'does', 'do', 'has', 'have', 'can', 'could', 'would', 'should', 'may', 'might'
]);

// Small list of well-known brands the model tends to name-drop.
// "amazon" is deliberately excluded — it's the platform itself, so the model
// legitimately references it when explaining PPC relevance.
const KNOWN_BRANDS = new Set([
  'nike', 'adidas', 'sony', 'samsung', 'apple', 'puma', 'reebok', 'bose',
  'jbl', 'lg', 'asics', 'newbalance', 'skechers', 'beats',
  'sennheiser', 'anker', 'google', 'microsoft', 'xiaomi', 'huawei'
]);

let groq = null;
function getClient() {
  if (!groq) {
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return groq;
}

// Calls the model for one test case. Returns raw response text plus timing.
// Throws on network/timeout errors — the caller handles per-case failures.
export async function evaluateTestCase(testCase) {
  const started = Date.now();
  const completion = await getClient().chat.completions.create(
    {
      model: MODEL,
      temperature: TEMPERATURE,
      messages: [
        { role: 'system', content: SYSTEM_PROMPTS[taskTypeOf(testCase)] },
        { role: 'user', content: testCase.inputText }
      ]
    },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  const latencyMs = Date.now() - started;
  const raw = completion.choices?.[0]?.message?.content ?? '';
  return { raw, latencyMs };
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$.\s]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.$]+|[.$]+$/g, '') || t)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// Simple word-diff heuristic: flag reasoning tokens that don't appear in the
// input and look like a brand name, a specific number/price, or a proper noun.
export function findHallucinations(inputText, reasoning) {
  const inputTokens = new Set(tokenize(inputText));
  const flagged = [];

  // Words that were capitalized in the original reasoning (mid-sentence proper
  // nouns), so we can catch brand-like words outside our known list.
  const capitalized = new Set(
    (reasoning.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]+\b/g) || []).map((w) => w.toLowerCase())
  );
  const allowedCapitalized = new Set(['high', 'low', 'brand', 'off', 'topic', 'intent', 'amazon', 'ppc', 'json']);

  for (const token of tokenize(reasoning)) {
    if (inputTokens.has(token)) continue;

    if (KNOWN_BRANDS.has(token)) {
      flagged.push({ token, reason: 'brand name not present in input' });
    } else if (/\d/.test(token) || token.startsWith('$')) {
      flagged.push({ token, reason: 'specific number/price not present in input' });
    } else if (capitalized.has(token) && !allowedCapitalized.has(token)) {
      flagged.push({ token, reason: 'capitalized brand-like word not present in input' });
    }
  }

  // De-duplicate by token
  const seen = new Set();
  return flagged.filter((f) => (seen.has(f.token) ? false : seen.add(f.token)));
}

// Runs the validation checks in order, short-circuiting on first failure.
export function validateResponse(testCase, raw) {
  const checks = [];
  let parsed = null;
  let accuracyMatch = null;
  let hallucinatedSnippets = [];

  // 1. JSON validity
  try {
    parsed = JSON.parse(raw);
    checks.push({ name: 'JSON validity', passed: true, detail: 'Parsed successfully' });
  } catch (err) {
    checks.push({ name: 'JSON validity', passed: false, detail: `Failed to parse: ${err.message}` });
    return { status: 'FAIL', checks, parsed, accuracyMatch, hallucinatedSnippets };
  }

  // 2. Schema
  const missing = ['classification', 'confidence', 'reasoning'].filter((k) => !(k in parsed));
  if (missing.length > 0) {
    checks.push({ name: 'Schema', passed: false, detail: `Missing field(s): ${missing.join(', ')}` });
    return { status: 'FAIL', checks, parsed, accuracyMatch, hallucinatedSnippets };
  }
  checks.push({ name: 'Schema', passed: true, detail: 'All required fields present' });

  // 3. Allowed classification
  const allowed = ALLOWED_CLASSIFICATIONS_BY_TYPE[taskTypeOf(testCase)];
  if (!allowed.includes(parsed.classification)) {
    checks.push({
      name: 'Classification value',
      passed: false,
      detail: `"${parsed.classification}" is not one of: ${allowed.join(', ')}`
    });
    return { status: 'FAIL', checks, parsed, accuracyMatch, hallucinatedSnippets };
  }
  checks.push({ name: 'Classification value', passed: true, detail: `"${parsed.classification}" is allowed` });

  // 4. Hallucination check
  hallucinatedSnippets = findHallucinations(testCase.inputText, String(parsed.reasoning));
  if (hallucinatedSnippets.length > 0) {
    checks.push({
      name: 'Hallucination',
      passed: false,
      detail: `Flagged: ${hallucinatedSnippets.map((f) => `"${f.token}" (${f.reason})`).join('; ')}`
    });
    return { status: 'FAIL', checks, parsed, accuracyMatch, hallucinatedSnippets };
  }
  checks.push({ name: 'Hallucination', passed: true, detail: 'No hallucinated snippets detected' });

  // 5. Accuracy (informational only — does not fail the case; skipped when
  // there's no expected classification, e.g. ad-hoc manual test-single runs)
  if (testCase.expectedClassification) {
    accuracyMatch = parsed.classification === testCase.expectedClassification;
    checks.push({
      name: 'Accuracy',
      passed: true,
      detail: accuracyMatch ? 'Match' : `Mismatch (expected "${testCase.expectedClassification}")`
    });
    console.log(`[eval] Case ${testCase.id}: ${accuracyMatch ? 'Match' : 'Mismatch'}`);
  }

  return { status: 'PASS', checks, parsed, accuracyMatch, hallucinatedSnippets };
}
