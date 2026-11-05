/**
 * Text normalization and session-tail extraction.
 *
 * Pure module: no I/O. Both routing (`decide`) and the prompt layer compare
 * free text, so the comparison form lives here once instead of in each caller.
 * @module file-maid/core/text
 */

/** Longest session tail the router reads, in characters. */
export const SESSION_TAIL_LIMIT = 2000;

/**
 * Fold one string into the comparison form: Unicode-normalized, lowercased,
 * whitespace collapsed.
 * @param {unknown} value - raw text.
 * @returns {string} the folded text, or an empty string.
 */
export function normalize(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Whether one folded haystack contains one folded needle.
 * @param {string} haystack - folded text.
 * @param {string} needle - folded text; empty never matches.
 * @returns {boolean} true when contained.
 */
export function contains(haystack, needle) {
  if (needle.length === 0) return false;
  return haystack.includes(needle);
}

/**
 * Read the plain text of one session message, tolerating both the string and
 * the parts-array content shapes.
 * @param {unknown} message - one derived message.
 * @returns {string} its text, or an empty string.
 */
function messageText(message) {
  const content = message?.content ?? message?.text;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.join('\n');
}

/**
 * Concatenate the tail of a session's derived messages, newest last.
 * @param {unknown} messages - derived messages, oldest first.
 * @param {number} [limit] - maximum characters kept.
 * @returns {string} the tail, or an empty string.
 */
export function sessionTail(messages, limit = SESSION_TAIL_LIMIT) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const pieces = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = messageText(messages[index]);
    if (text.length === 0) continue;
    pieces.unshift(text);
    if (pieces.join('\n').length >= limit) break;
  }
  const joined = pieces.join('\n');
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

/**
 * Clip one string to a maximum length, appending an ellipsis when cut.
 * @param {string} value - text to clip.
 * @param {number} limit - maximum length, ellipsis included.
 * @returns {string} the clipped text.
 */
export function clip(value, limit) {
  if (value.length <= limit) return value;
  if (limit <= 1) return '…'.slice(0, limit);
  return `${value.slice(0, limit - 1)}…`;
}
