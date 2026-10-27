// Policy check for one recorded run of the live-status service.
// Judges observed behaviour only: upstream calls to claims-core and log lines.
// Never mutates the observation; sorting happens on copies.

const WINDOW_MS = 1000;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCall(value) {
  return isPlainObject(value)
    && typeof value.customerCode === 'string' && value.customerCode.length > 0
    && typeof value.atMs === 'number' && Number.isFinite(value.atMs);
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Returns a list of problems that make the observation unusable as evidence.
function shapeProblems(observation) {
  if (!isPlainObject(observation)) return ['observation must be an object'];
  const problems = [];
  for (const field of ['requests', 'upstreamCalls', 'responses', 'logs']) {
    if (!Array.isArray(observation[field])) problems.push(`observation.${field} must be an array`);
  }
  if (Array.isArray(observation.requests)) {
    if (observation.requests.length === 0) problems.push('observation.requests is empty: no evidence to evaluate');
    if (!observation.requests.every(isCall)) problems.push('every request needs a customerCode string and a finite atMs');
  }
  if (Array.isArray(observation.upstreamCalls) && !observation.upstreamCalls.every(isCall)) {
    problems.push('every upstream call needs a customerCode string and a finite atMs');
  }
  if (Array.isArray(observation.logs) && !observation.logs.every((line) => typeof line === 'string')) {
    problems.push('every log line must be a string');
  }
  const requirements = observation.requirements;
  if (!isPlainObject(requirements)) {
    problems.push('observation.requirements is missing');
  } else {
    if (!isPositiveNumber(requirements.maxRequestsPerSecond)) problems.push('requirements.maxRequestsPerSecond must be a positive number');
    if (!isPositiveNumber(requirements.cacheTtlMs)) problems.push('requirements.cacheTtlMs must be a positive number');
    const fragments = requirements.forbiddenLogFragments;
    if (!Array.isArray(fragments) || !fragments.every((f) => typeof f === 'string' && f.length > 0)) {
      problems.push('requirements.forbiddenLogFragments must be an array of non-empty strings');
    }
  }
  return problems;
}

// CACHE-1: per customer, consecutive upstream calls must be at least cacheTtlMs apart.
function checkCache(upstreamCalls, cacheTtlMs) {
  const byCustomer = new Map();
  for (const call of upstreamCalls) {
    if (!byCustomer.has(call.customerCode)) byCustomer.set(call.customerCode, []);
    byCustomer.get(call.customerCode).push(call.atMs);
  }
  const violations = [];
  for (const [customerCode, times] of byCustomer) {
    const sorted = times.slice().sort((a, b) => a - b);
    let early = 0;
    let firstGap = null;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap < cacheTtlMs) {
        early++;
        if (firstGap === null) firstGap = {at: sorted[i], gap};
      }
    }
    if (early > 0) {
      violations.push(`CACHE-1: ${early} upstream call(s) for ${customerCode} came less than ${cacheTtlMs} ms after the previous call (first at ${firstGap.at} ms, ${firstGap.gap} ms after the previous)`);
    }
  }
  return violations;
}

// RATE-1: no rolling one-second window [t, t + 1000) holds more than the limit.
function checkRate(upstreamCalls, maxPerSecond) {
  const times = upstreamCalls.map((call) => call.atMs).sort((a, b) => a - b);
  let worst = 0;
  let worstStart = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] >= WINDOW_MS) start++;
    const count = end - start + 1;
    if (count > worst) {
      worst = count;
      worstStart = times[start];
    }
  }
  if (worst <= maxPerSecond) return [];
  return [`RATE-1: ${worst} upstream calls to claims-core within one second starting at ${worstStart} ms (limit ${maxPerSecond})`];
}

// PRIVACY-1: no log line contains a forbidden fragment (case-insensitive).
function checkPrivacy(logs, fragments) {
  const violations = [];
  logs.forEach((line, index) => {
    const lower = line.toLowerCase();
    const found = fragments.filter((fragment) => lower.includes(fragment.toLowerCase()));
    if (found.length > 0) {
      violations.push(`PRIVACY-1: log line ${index} contains forbidden fragment(s): ${found.join(', ')}`);
    }
  });
  return violations;
}

export function evaluate(observation) {
  const problems = shapeProblems(observation);
  if (problems.length > 0) {
    return {pass: false, violations: problems.map((problem) => `MALFORMED: ${problem}`)};
  }
  const {upstreamCalls, logs, requirements} = observation;
  const violations = [
    ...checkCache(upstreamCalls, requirements.cacheTtlMs),
    ...checkRate(upstreamCalls, requirements.maxRequestsPerSecond),
    ...checkPrivacy(logs, requirements.forbiddenLogFragments),
  ];
  return {pass: violations.length === 0, violations};
}
