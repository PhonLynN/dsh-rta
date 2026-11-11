/**
 * tools/spec.js — RTA 十个工具的契约（**不含 execute**）。
 *
 * 宿主管参数走 schema：schema 没声明的参数会被静默丢掉，所以 handler 读的
 * 每个参数都必须在这里出现。宿主只支持 string/number/integer/boolean/null/
 * array/object/json/oneOf 这些关键词（没有 minimum/maximum/pattern），
 * 取值范围写在 description 里，由 handler 兜底。
 *
 * 文案原则（agent-experience）：常驻描述只写「做什么、返回什么、什么时候用」，
 * 默认值和范围写在参数上；调优细节不进常驻上下文。
 */

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: 'Concise result plus identifiers for follow-up calls.' },
    },
  },
  render(args, value) {
    return [{ type: 'text', text: value.text }];
  },
};

const IMAGE_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', required: true, description: 'Timestamped index of the frames in the image.' },
      images: {
        type: 'array',
        required: true,
        items: { type: 'json' },
        description: 'Zero or more committed image attachments (one sheet image).',
      },
    },
  },
  render(args, value) {
    return [
      ...(value.images ?? []).map((attachment) => ({ type: 'image', attachment })),
      { type: 'text', text: value.text },
    ];
  },
};

export const TOOL_NAMES = Object.freeze({
  start: 'rta_start',
  stop: 'rta_stop',
  status: 'rta_status',
  summarize: 'rta_summarize',
  look: 'rta_look',
  region: 'rta_region',
  recall: 'rta_recall',
  note: 'rta_note',
  sessions: 'rta_sessions',
  purge: 'rta_purge',
});

export function startSpec() {
  return {
    name: TOOL_NAMES.start,
    description: 'Start RTA screen capture (the "eyes"). Once started, the screen state is injected into this '
      + 'conversation automatically (a short runtime-context snapshot whenever something noticeable changes, '
      + 'plus at most one budgeted HD screenshot at the start of a turn) — you do NOT need to call rta_look to '
      + 'know what the user is doing. A background summarizer subagent is also started while recording (one '
      + 'persistent child for the whole session): it writes a rolling 2-4 sentence summary of what is happening '
      + 'on screen (note name="screen-log"), refreshed periodically, on dense screen changes, and on demand via '
      + 'rta_summarize; the newest summary is attached at the start of each turn. The main conversation is never '
      + 'interrupted or woken by this — summaries arrive passively with the next turn. rta_stop clears that '
      + 'subagent. Frames are stored locally and expire 24h after the session ends. Idempotent: returns the '
      + 'current session if already recording. Binds RTA to the calling session — RTA serves only one session at '
      + 'a time, and while recording a global always-on-top floating window shows its status.',
    parameters: {},
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return false; },
  };
}

export function stopSpec() {
  return {
    name: TOOL_NAMES.stop,
    description: 'Stop RTA capture and end the session. Also closes the floating window, clears the summary '
      + 'subagent, and releases the single-session binding, so another conversation can start RTA. Returns the '
      + 'session summary (id, dir, counts, image retain-until). Text records stay available via rta_recall; '
      + 'images expire 24h after the session ends.',
    parameters: {
      reason: { type: 'string', description: 'Why the session ended; stored in the manifest (default "explicit").' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return false; },
  };
}

export function statusSpec() {
  return {
    name: TOOL_NAMES.status,
    description: 'Read RTA status without sending any image: capture rate, session id/dir, frame counts, '
      + 'current foreground window, recent selected moments, automatic injection stats (channel, publish '
      + 'count, injected HD screenshots), background summarizer stats (provider, child id, prompts, errors, '
      + 'summary age, last trigger), last error.',
    parameters: {},
    output: TEXT_OUTPUT,
    timeoutMs: 10_000,
    isConcurrencySafe() { return true; },
  };
}

export function summarizeSpec() {
  return {
    name: TOOL_NAMES.summarize,
    description: 'Ask the background summarizer subagent for a FRESH screen summary right now and return it. '
      + 'The summarizer normally runs on its own (periodically, and when dense screen changes happen) and '
      + 'writes a rolling 2-4 sentence summary into note "screen-log"; this tool is the on-demand override: '
      + 'it nudges the same persistent subagent, waits up to waitMs for it to write the new summary, and '
      + 'returns that text with its age. Use it before answering anything that depends on what the user is '
      + 'doing right now, after a long period of activity, or when the injected summary looks stale. It never '
      + 'interrupts or wakes the main conversation.',
    parameters: {
      waitMs: {
        type: 'integer',
        description: 'How long to wait for the new summary, 0-60000 (default 25000). 0 = just nudge and return immediately.',
      },
      reason: {
        type: 'string',
        description: 'Optional: why the summary is requested. Recorded in the summarizer log.',
      },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 40_000,
    isConcurrencySafe() { return true; },
  };
}

export function lookSpec() {
  return {
    name: TOOL_NAMES.look,
    description: 'See what is on the user\'s screen now. By default this returns ONE cropped HD frame: the '
      + 'frame is extracted from the native 2560x1440 recording, cropped to the foreground window / circled '
      + 'area, and downscaled to the token budget — much sharper than the old 512x288 sheet, so on-screen text '
      + 'is often readable. Pass hd:false (or count>1) for the older multi-frame sheet. Starts capture if it is '
      + 'not running. While RTA is running the screen state and the background summary are already injected '
      + 'automatically — use this only when you need a fresh close-up or the actual pixels, not as a polling '
      + 'loop. Also useful when the user says "look at this" or after a summon. If RTA is currently bound to a '
      + 'different session this returns a notice instead of stealing that capture.',
    parameters: {
      count: {
        type: 'integer',
        description: 'How many frames to include, 1-6 (default 2; the HD path keeps 1-2, the sheet path up to 6).',
      },
      maxTokens: {
        type: 'integer',
        description: 'Token budget for the image(s); HD width and sheet grid are picked from it (default 1200).',
      },
      hd: {
        type: 'boolean',
        description: 'Use the HD cropped-frame path (default true). Set false for the legacy multi-frame sheet.',
      },
      note: {
        type: 'string',
        description: 'Optional: why you are looking. Recorded with the frames for later recall.',
      },
    },
    output: IMAGE_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return true; },
  };
}

export function regionSpec() {
  return {
    name: TOOL_NAMES.region,
    description: 'Show the user\'s most recent circled screen area (they hold Shift+Ctrl+Alt and draw). '
      + 'Returns the crop and its screen coordinates plus start/end timestamps. Use when the user points '
      + 'at something; fall back to rta_look when nothing has been circled.',
    parameters: {
      count: { type: 'integer', description: 'How many recent regions to include, 1-4 (default 1).' },
      regionId: { type: 'integer', description: 'Specific region id from an earlier result, instead of the latest.' },
    },
    output: IMAGE_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return true; },
  };
}

export function recallSpec() {
  return {
    name: TOOL_NAMES.recall,
    description: 'Search RTA\'s local timeline by wall-clock time and get text records (frames, circled '
      + 'regions, notes) with timestamps. Use it to answer "what happened at 20:51" or to recover a '
      + 'moment whose image you already read. Per-frame archive rows are hidden by default (thousands of '
      + 'rows would drown the events) — pass types="frame" if you really want them. With images:true it '
      + 'picks up to maxImages informative moments spread across the window (not just the last three), '
      + 'extracts each as a cropped HD frame from the native 2560x1440 recording and attaches them. Images '
      + 'on disk expire 24h after the session ends and are then reported as expired; text is permanent.',
    parameters: {
      from: { type: 'string', description: 'Start of the window: ISO 8601 or epoch milliseconds. Default: session start.' },
      to: { type: 'string', description: 'End of the window: ISO 8601 or epoch milliseconds. Default: now.' },
      limit: { type: 'integer', description: 'Max records to return, 1-100 (default 40).' },
      types: {
        type: 'string',
        description: 'Comma-separated kinds: frame,event,region,note,sheet (default all except per-frame archive rows).',
      },
      images: {
        type: 'boolean',
        description: 'Attach cropped HD frames for up to maxImages informative moments in the window (default false — costs tokens).',
      },
      maxImages: {
        type: 'integer',
        description: 'How many HD frames to attach when images:true, 1-4 (default 3).',
      },
    },
    output: IMAGE_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return true; },
  };
}

export function noteSpec() {
  return {
    name: TOOL_NAMES.note,
    description: 'Write a short structured note into the session\'s permanent text memory (what you saw, '
      + 'what changed, what the user pointed at and said). Notes survive image expiry and are what later '
      + 'recall/new sessions read. Call once after reading each batch of images.',
    parameters: {
      name: { type: 'string', required: true, description: 'Short slug, e.g. "00-52-video-design-notes".' },
      text: { type: 'string', required: true, description: 'The note. Timestamp anchors + facts, not prose.' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 10_000,
    isConcurrencySafe() { return true; },
  };
}

export function sessionsSpec() {
  return {
    name: TOOL_NAMES.sessions,
    description: 'List recent RTA sessions (id, dir, start/end, frame/region counts) so you can recall '
      + 'an earlier session by time. Pass its session id to rta_recall is not supported yet — this returns '
      + 'the timeline location instead.',
    parameters: {
      limit: { type: 'integer', description: 'How many sessions, 1-20 (default 8).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 10_000,
    isConcurrencySafe() { return true; },
  };
}

export function purgeSpec() {
  return {
    name: TOOL_NAMES.purge,
    description: 'Free disk early by deleting images/video that are already summarized into text. '
      + 'Normal retention is still 24h after the session ends; this only does what the user asks '
      + 'right now (e.g. after the AI has written notes about a stretch of screen). Keeps the last '
      + 'keepMinutes minutes by default, never deletes index/notes/annotations/manifest, and never '
      + 'touches the segment currently being recorded. Call it when the user says "these images are '
      + 'no longer needed / clean them up".',
    parameters: {
      sessionId: { type: 'string', description: 'Session id to purge (default: current session, else most recent ended one).' },
      keepMinutes: { type: 'integer', description: 'Keep images newer than this many minutes (default 2, 0-1440).' },
      before: { type: 'string', description: 'Explicit cutoff: ISO 8601 or epoch ms. Overrides keepMinutes.' },
      dryRun: { type: 'boolean', description: 'Preview how many files/bytes would be deleted without deleting (default false).' },
    },
    output: TEXT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe() { return true; },
  };
}
