// The smallest version an npm dependency spec allows, for the undici override tripwire in
// config.test.mjs. Handles what package.json files actually use: exact, =, v, ^, ~, >=, >, <, <=,
// x-ranges (7.x, 7.31, *), hyphen ranges (a - b), space-joined comparator sets and || alternatives.
// Anything else (tags, URLs, npm: aliases) returns null, and the tripwire treats null as a failure.
// Prerelease and build tags are ignored for the minimum: a prerelease of 7.31.0 still sits above
// 7.30.x, which is all the tripwire needs.

const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function compareVersions(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

// One comparator to the lowest version it admits, or 'upper' for < and <= (they cap, never raise).
function lowerBound(comp) {
  const m = COMPARATOR.exec(comp);
  if (!m) return null;
  const op = m[1] || '';
  const parts = [m[2], m[3], m[4]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  if (op === '<' || op === '<=') return 'upper';
  const base = parts.map((p) => (p === null ? 0 : p));
  if (op !== '>') return base;
  // Strictly greater, at the precision given: >7 is 8.0.0, >7.31 is 7.32.0, >7.31.0 is 7.31.1.
  if (parts[0] === null) return null; // >* admits nothing
  if (parts[1] === null) return [base[0] + 1, 0, 0];
  if (parts[2] === null) return [base[0], base[1] + 1, 0];
  return [base[0], base[1], base[2] + 1];
}

function minOfSet(set) {
  const s = set.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1'); // ">= 7.31.0" is valid npm syntax
  if (s === '') return [0, 0, 0];
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
  if (hyphen) {
    const lo = lowerBound(hyphen[1]);
    return Array.isArray(lo) && /^v?[\dxX*]/.test(hyphen[1]) ? lo : null;
  }
  let lo = [0, 0, 0];
  for (const comp of s.split(/\s+/)) {
    const b = lowerBound(comp);
    if (b === null) return null;
    if (b !== 'upper' && compareVersions(b, lo) > 0) lo = b;
  }
  return lo;
}

// [major, minor, patch] or null.
export function minVersion(spec) {
  if (typeof spec !== 'string') return null;
  let best = null;
  for (const alt of spec.split('||')) {
    const m = minOfSet(alt);
    if (m === null) return null;
    if (best === null || compareVersions(m, best) < 0) best = m;
  }
  return best;
}

// Why an exact override would pull a package below what its dependent asks for, or null if fine.
export function overrideProblem(override, spec) {
  const want = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(override));
  if (!want) return `override "${override}" is not an exact version`;
  const min = minVersion(spec);
  if (min === null) return `can't read the declared spec "${spec}"; check the override by hand`;
  if (compareVersions(want.slice(1).map(Number), min) < 0) {
    return `the declared spec "${spec}" needs at least ${min.join('.')}; the override ${override} would downgrade it`;
  }
  return null;
}
