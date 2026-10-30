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
    clock: 'clock ',
    trigger: 'trigger '
};

// Matches the keypad/hardware-native shape of a Trigger Control line, e.g.
// "trigger max //MIDSTRM/254/202/2" (after normalizeAppEventLine has already
// stripped a leading "#"/"#e#" marker and the trailing " #sourceunit=…"
// metadata). Deliberately only min/max — numeric selectors arrive as
// "trigger event <addr> <n>" and are not comment-prefixed, so they already
// reach CBusEvent directly via its own fast path.
const TRIGGER_MIN_MAX_REGEX = /^trigger\s+(min|max)\s+(\S+)/i;

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

/**
 * Decodes a keypad/hardware-native Trigger Control (app 202/$CA) line — one
 * where a trigger group's action selector is set to its bottom (`min`) or
 * top (`max`) value from a hardware source (e.g. a keypad "Secondary
 * Application" key) rather than a `TRIGGER EVENT` command. C-Gate renders
 * these as "[# ]trigger min|max //PROJECT/<net>/<app>/<group> …", which
 * CBusEvent's fast path cannot read as a level (`min`/`max` are not digits)
 * and which — being `#`-comment-prefixed — the bridge's generic comment
 * filter would otherwise drop before CBusEvent ever sees it (issue #162).
 *
 * Rewrites the line into the same "trigger event <addr> <selector>" shape a
 * numeric TRIGGER EVENT produces (0 for min, 255 for max, per C-Gate's own
 * action-selector range), preserving the original address token — including
 * any "//PROJECT/" prefix — and any trailing " #sourceunit=…" metadata
 * verbatim, so the rewritten line re-enters CBusEvent's already-tested
 * address and metadata parsing unchanged.
 *
 * @param {string} line - Raw line from the C-Gate event stream.
 * @returns {string|null} A rewritten line ready for `new CBusEvent(...)`, or
 *   null if `line` is not a trigger min/max line at all.
 */
function decodeTriggerMinMaxLine(line) {
    const normalized = normalizeAppEventLine(line, 'trigger');
    if (!normalized) return null;

    const match = TRIGGER_MIN_MAX_REGEX.exec(normalized.text);
    if (!match) return null;

    const selector = match[1].toLowerCase() === 'max' ? 255 : 0;
    const addressToken = match[2];
    const metadata = normalized.metadata || '';
    return `trigger event ${addressToken} ${selector}${metadata}`;
}

module.exports = { normalizeAppEventLine, isAppEventLine, LINE_UNPARSED, decodeTriggerMinMaxLine };
