/**
 * @fileoverview Sanitise log lines for the on-disk debug log.
 *
 * Sensitive values (phone numbers, IMEIs, generated identity names) are
 * replaced with `<KIND:shortHash>` placeholders. The hash is deterministic:
 * the same input always yields the same placeholder, so correlations across
 * lines remain readable when an external reader walks the file.
 */

const crypto = require('crypto');

/** @type {Map<string, string>} */
const hashCache = new Map();

/**
 * Short SHA-256 prefix, cached. 6 hex chars = 24 bits = ~16M values; collision
 * risk is irrelevant inside a single debug session.
 * @param {string} s
 * @returns {string}
 */
function shortHash(s) {
  let h = hashCache.get(s);
  if (h) return h;
  h = crypto.createHash('sha256').update(s).digest('hex').slice(0, 6);
  hashCache.set(s, h);
  return h;
}

/**
 * Redact a log line by replacing PII with deterministic placeholders.
 * Order matters: longer / more specific patterns run first so they aren't
 * partially clobbered by shorter rules (an IMEI is also a digit run that the
 * phone-number rule could otherwise grab).
 *
 * @param {string} text
 * @returns {string}
 */
/**
 * Normalise a phone number for hashing: strip + prefix and any whitespace
 * so the same number always maps to the same hash regardless of formatting.
 * @param {string} num
 * @returns {string}
 */
function normalisePhone(num) {
  return num.replace(/[\s+]/g, '');
}

/**
 * Capitalised "Firstname Lastname"-shaped pattern (Unicode-aware so French
 * accented names like "François" match). Constrains to 2 word maximum and
 * letters-only (no digits, no punctuation other than `-`).
 */
const NAME_PATTERN = String.raw`\p{Lu}[\p{Ll}-]+(?:\s\p{Lu}[\p{Ll}-]+)?`;

function redact(text) {
  if (typeof text !== 'string') return text;

  // IMEI: 14-17 digit run as a standalone token. Most common form in this
  // codebase: bare digits on their own line ("[AT:0] <<< 869123456789012")
  // or after "IMEI"/"IMEI:"/"IMEI =" prefixes. Word boundaries cover all.
  text = text.replace(/\b\d{14,17}\b/g, (m) => `<IMEI:${shortHash(m)}>`);

  // E.164 phone numbers (+ then 8-13 digits). Hash the normalised form
  // (without +) so a number logged with and without leading + gets the
  // same placeholder — keeps cross-line correlation readable.
  text = text.replace(/(?<!\d)\+\d{8,13}(?!\d)/g, (m) => `<PHONE:${shortHash(normalisePhone(m))}>`);

  // Bare phone digit runs (7-13). Below 7 covers 4-6 digit codes, USSD
  // identifiers, signal values, indices — leaving those alone avoids
  // over-redaction. Above 13 was already caught by the IMEI rule.
  //
  // Skip lines that carry LTE/GSM infrastructure identifiers (CPSI, CREG,
  // CEREG, CGREG, COPS): cell IDs and TACs in those lines can be all-digit
  // decimals or all-digit hex strings (no a-f letters by chance) that look
  // like phone numbers but are network-side identifiers, not PII.
  if (!/\+(?:CPSI|CREG|CEREG|CGREG|COPS):/i.test(text)) {
    text = text.replace(/\b\d{7,13}\b/g, (m, offset, full) => {
      // Skip token-immediate contexts that are clearly NOT phone numbers:
      // Google Sheet GIDs, ifIndex, port numbers, byte counts, etc.
      const before = full.slice(Math.max(0, offset - 12), offset).toLowerCase();
      if (/(?:gid|ifindex|index|port|count|size|bytes|chunk|seq|id)=$/.test(before)) return m;
      return `<PHONE:${shortHash(normalisePhone(m))}>`;
    });
  }

  // Generated identity names. We redact only on KNOWN markers — never
  // blanket-match anything that looks like "Capital Capital", which would
  // false-positive on things like "Found 2 AT", "Switching MUX", etc.
  // Each pattern is intentionally narrow.
  const nameMarkers = [
    // "— Firstname Lastname"
    new RegExp(`(— )(${NAME_PATTERN})`, 'gu'),
    // "in sheet: Firstname Lastname"
    new RegExp(`(in sheet:\\s+)(${NAME_PATTERN})`, 'gu'),
    // "already in sheet (Firstname Lastname)" — restrict to the name shape,
    // so legit non-name tokens like "(cached)" / "(stale)" don't get hashed.
    new RegExp(`(in sheet \\()(${NAME_PATTERN})(\\))`, 'gu'),
    // "name: Firstname Lastname" — covers our "provisional name:" log etc.
    new RegExp(`(name:\\s+)(${NAME_PATTERN})`, 'gu'),
    // "exists — Firstname Lastname" / "is Firstname Lastname"
    new RegExp(`(exists\\s+—\\s+|\\bis\\s+)(${NAME_PATTERN})`, 'gu'),
  ];
  for (const re of nameMarkers) {
    text = text.replace(re, (_m, prefix, name, ...rest) => {
      // The optional 3rd capture (")") only exists for the parenthesis form.
      const suffix = typeof rest[0] === 'string' ? rest[0] : '';
      return `${prefix}<NAME:${shortHash(name)}>${suffix}`;
    });
  }

  return text;
}

module.exports = { redact };
