# C-Bus Audio (205) and Media Transport (192) — Investigation Notes

Where cgateweb stands on the C-Bus **Audio** application (app `205`, `$CD`) and the
**Media Transport Control** application (app `192`, `$C0`), what is still unknown, and
how to capture the data needed to close the gap. Tracks
[issue #172](https://github.com/dougrathbone/cgateweb/issues/172).

> **Status legend:** ✅ verified against real hardware · ⚠️ from the C-Gate manual only ·
> ❓ unknown / not captured.

## Current state

Nothing is decoded. What the bridge does today:

- Audio and Media Transport event lines are claimed by `src/audioEventHandler.js`, so they no
  longer log "Could not parse event line" (their address has two segments, no group, which
  `CBusEvent` cannot parse).
- Each line is passed to raw event capture. Set `cbus_raw_event_log_apps` to `[205, 192]` and
  every line is logged verbatim and published to `cbus/read/{net}/{app}/raw`.
- The first line of each application also logs one INFO message saying how to capture.

Nothing is published to Home Assistant and no audio command can be written. That is deliberate:
see "Why not guess" below.

## What the C-Gate manual gives us (⚠️)

Audio commands (sections 4.5.16–4.5.35), addressed `audio <verb> <net>/205 …`:

| Verb | Arguments | Meaning per manual |
|---|---|---|
| `current_feed` | `mux zone feed gain` | Reports the current feed (`feed` 0..7, `gain` 0..4) |
| `set_feed` | `mux zone feed option` | Sets the zone's feed |
| `next_feed` / `previous_feed` | `mux zone` | Step the feed |
| `request_current_feed` | `mux zone` | Ask for `current_feed` |
| `mute` | `mux zone mode` | `0` amp off, `2` volume normal/speakers off, `5` volume preset/speakers off, `7` volume preset/speakers on, `255` volume normal/speakers on |
| `on` / `off` | `mux zone code` | Send an on/off operation |
| `ramp` | `mux zone code level rate` | Ramp a zone function to `level` 0..255; `rate` 0..15 (0 instant, 1 = 4 s … 15 = 17 min) |
| `terminateramp` | `mux zone code` | Stop a ramp |

`mux` is 0..2, `zone` 0..7. Every verb also has a `Z <function>` form where `function` (0..255)
replaces `mux zone`. Other verbs exist for labelling (`zone_descriptor_request`,
`zone_feed_label_request`), `high_priority`, `dynamic_1/2`, `next_language`,
`output_common_control`, `output_device_status_request` and `output_error_code`.

Media Transport commands (sections 4.5.99–4.5.118) take `app group [operation]`, where `group` is
the media-link group: `play`, `pause`, `stop`, `next_track`, `set_track`, `forward`, `rewind`,
`shuffle`, `repeat`, `source_power`, `status_request`, `enumerate`, `set_category`, and friends.

The manual's sample line for the event port shows the `#`-prefixed shape:
`# audio zone_feed_label_request //BOARD/254/205 1 2 #sourceunit=0 OID=…`

## What we do not know (❓)

These block a decoder. Each needs a real capture, or the audio protocol document
(*C-Bus Application Messages and Behaviour*, chapter 14, CBUS-APP/14), which is not in this
repository:

1. **What zone function `code` means.** `ramp`/`on`/`off` take a `code` 0..7. Volume is the
   obvious candidate, but the manual does not say.
2. **Feed to source name.** `feed` is 0..7; nothing maps a number to "Tuner" or "CD". Labels come
   from `zone_feed_label_request` traffic or the C-Gate database, and we have not seen either.
3. **Whether `mute` mode 0 is the only "power off".** Mode 0 turns the amplifier off, but
   whether the amp reports state changes on the bus, and as which verb, is unobserved.
4. **Event grammar.** Which verbs a real amp or matrix emits unprompted, whether they arrive as
   `audio …` or `#s# audio …`, and what `#sourceunit` identifies.
5. **Media Transport group semantics.** Which `group` values real players use, and whether state
   (playing, track number) is reported or only commanded.

## Why not guess

The HVAC work (see [HVAC_INVESTIGATION.md](./HVAC_INVESTIGATION.md)) showed what a plausible
but unverified decoder does: it publishes confident nonsense that looks right until someone
checks it against a real device. Unknown semantics here fail closed, as in
`src/applicationDecoders/clockDecoder.js`.

## Home Assistant mapping constraint

Home Assistant's MQTT integration has **no `media_player` discovery platform**. The issue asks for
media players, which cannot be created through MQTT Discovery. What MQTT Discovery does support,
and what an audio zone maps onto once decoded:

| Zone capability | HA entity |
|---|---|
| Amplifier power / mute mode | `switch`, or a `select` over the `mute` modes |
| Source (feed) | `select` |
| Volume | `number` |
| Transport (play, pause, next) | `button` |

A true `media_player` would need a custom integration, which is out of scope for this bridge.
Whether to ship the entity set above is a decision for after the captures are in.

## How to capture (for testers)

1. Set `cbus_raw_event_log_apps` to `[205, 192]` (add-on option or `settings.js`).
2. Restart the bridge and, with the C-Bus audio hardware idle, work through each action on a
   real keypad, touchscreen or the manufacturer's app: change source, change volume (note the
   direction and rough amount), mute, unmute, power the zone off and on, and play, pause and skip
   on any media-transport source.
3. Write down what you did next to each line. The log lines are the evidence; the notes tell us
   what they mean.
4. Collect the `C-Gate raw capture [app 205]` / `[app 192]` log entries, or subscribe to `cbus/read/+/205/raw` and
   `cbus/read/+/192/raw`. Keypad PINs are redacted, but check before sharing.
5. If you can, attach the C-Gate project's audio zone and feed labels as well.

## Plan

1. **Capture** (this change): claim the lines, make them capturable.
2. **Decode** once captures confirm the grammar: `audioDecoder.js` under
   `src/applicationDecoders/` with fixtures taken verbatim from real captures, published as
   read-only state.
3. **Discover** the entity set above, read-only first.
4. **Control**: command writes on `cbus/write/...`, only for operations confirmed on hardware.
