// @ts-check

/**
 * Shared preamble for per-application event-line handling (aircon, security,
 * measurement, clock). Decoders and isXLine guards used to duplicate the same
 * steps: trim → strip a C-Gate EVENT channel prefix or a leading '#' comment
 * marker → require the application prefix → split off trailing " #…" metadata.
 * Kept tiny and allocation-light — it runs on every event-port line.
 */

// Hoisted "<prefix> " strings: building them per line allocated on every
// event-port line (isAppEventLine runs up to four times per line).
const PREFIX_WITH_SPACE = {
    aircon: 'aircon ',
    security: 'security ',
    measurement: 'measurement ',
    clock: 'clock '
};

/**
 * Strip a C-Gate EVENT digit-level channel prefix ("#e# "/"#s# "/"#c# ",
 * manual §4.5.83) or a single leading "#" / "# " comment marker. One pass;
 * does not recurse. `s` must already be trimmed.
 *
 * @param {string} s
 * @returns {string}
 */
function stripLeadingHashPrefix(s) {
    if (s.length === 0 || s.charCodeAt(0) !== 35) return s; // not '#'
    // #e# / #s# / #c#  (second '#' at index 2)
    if (
        s.length >= 4 &&
        s.charCodeAt(2) === 35 &&
        (s.charCodeAt(1) === 101 || s.charCodeAt(1) === 115 || s.charCodeAt(1) === 99)
    ) {
        return s.slice(3).trim();
    }
    return s.slice(1).trim();
}

/**
 * Normalize a raw C-Gate event line for a per-application decoder: trim,
 * strip an EVENT channel prefix or one leading "#" comment marker, require
 * the `<prefix> ` application prefix, then split the trailing metadata
 * (" #sourceunit=…") from the body.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @param {string} prefix - Application prefix without trailing space (e.g. 'aircon', 'security').
 * @returns {{ text: string, metadata: string|null }|null}
 *   `text` is the body up to (not including) any trailing metadata; `metadata`
 *   is the portion from the first " #" onward (including the space) or null.
 *   Returns null for non-strings and lines without the application prefix.
 */
function normalizeAppEventLine(line, prefix) {
    if (typeof line !== 'string') return null;

    let text = stripLeadingHashPrefix(line.trim());

    if (!text.startsWith(PREFIX_WITH_SPACE[prefix] || `${prefix} `)) return null;

    const metaIdx = text.indexOf(' #');
    let metadata = null;
    if (metaIdx !== -1) {
        metadata = text.slice(metaIdx);
        text = text.slice(0, metaIdx);
    }
    return { text, metadata };
}

/**
 * Whether a raw event line belongs to the given application (a `<prefix> …`
 * line, optionally `#`-comment-prefixed or `#s#`/`#e#`/`#c#` channel-prefixed),
 * regardless of feature gating or decodability — the shared
 * isAirconLine/isSecurityLine check. Such lines are never valid CBusEvents, so
 * callers use this to keep them out of the standard parser.
 *
 * Lines arriving via LineProcessor are already trimmed (trimLines default);
 * trim() is retained so the result is identical for every other input (V8
 * returns the same string object when there is nothing to trim).
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @param {string} prefix - Application prefix without trailing space.
 * @returns {boolean}
 */
function isAppEventLine(line, prefix) {
    if (typeof line !== 'string' || line.length === 0) return false;
    const s = stripLeadingHashPrefix(line.trim());
    return s.startsWith(PREFIX_WITH_SPACE[prefix] || `${prefix} `);
}

// Tri-state result of a specialised app handler's handleLine. `true` means the
// line was consumed; LINE_UNPARSED means it is this app's traffic but was not
// consumed (the caller should log and keep it out of the generic parser);
// `false` means the line is not this app's traffic at all (feature disabled
// included). Returning the state instead of a boolean lets the caller skip a
// second isAppEventLine classification on its fall-through path.
const LINE_UNPARSED = 'unparsed';

module.exports = { normalizeAppEventLine, isAppEventLine, LINE_UNPARSED };
