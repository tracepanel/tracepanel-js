// Where a trace's time goes in code: V8's sampling profiler, through Node's inspector (the trace's `profile`, a flame
// graph in the console). Nothing runs until a trace is profiled: the setting profiles every one, a request asks with
// the X-Tracepanel-Profile: 1 header or the panel's tracepanel_profile=1 cookie. "memory" there rather than "1", or
// TRACEPANEL_PROFILE_MEMORY=1, profiles its memory too (memory.ts). Every profile has the collector's runs (`gc`).
//
// The profiler samples the whole thread, and one event loop runs every request of the process at once: a sample
// can't tell which request a frame belongs to. So a profiled trace keeps the samples taken while it was the only trace
// running here, as the Python SDK keeps a thread's samples only while it runs one trace; those taken while another
// ran too are dropped and counted (`tracepanel.dropped_samples`). What the process did meanwhile outside any request
// (a timer, the garbage collector) is in the profile too. Samples of an idle loop, the request waiting on I/O, are
// left out: the profile is where the time went in code, on the CPU.
//
// One profile runs for as long as traces are profiled, so starting the next one costs next to nothing (the first
// start reads every function V8 has compiled: tens of milliseconds); each trace's own profile is a console.profile()
// under it, from its start to its end. It stops IDLE_MS after the last one.

import { relative } from "node:path";
import { createContextKey } from "@opentelemetry/api";
import type { Config } from "./config.js";
import { call, connect, inspector, type Session } from "./inspector.js";
import { type CallFrame, Collections, type Heap, HeapSampler, memoryAvailable, type Site } from "./memory.js";
import type { Profile, ProfileFrame, ProfileMemory } from "./model.js";
import { headerValue, parseCookies, type RequestHeaders } from "./request.js";
import { inApp, libraryPath, ownFile, place } from "./stack.js";

export const HEADER = "x-tracepanel-profile";
export const COOKIE = "tracepanel_profile";
/** On a request's root span: what the request asked for ("1", or "memory"). */
export const ATTRIBUTE = "tracepanel.profile";
/** In the context a framework starts the request's root span in (Next.js's): what the request asked for. */
export const ASKED = createContextKey("tracepanel.profile");
/** On a request's root span, and in the framework's context beside ASKED: how the request asked (Reason). */
export const REASON_ATTRIBUTE = "tracepanel.profile.reason";
export const REASON = createContextKey("tracepanel.profile.reason");
/** On a profiled trace: why it is profiled. */
export const PROFILE_REASON = "profile.reason";

// How deep a stack is kept: a recursion beyond it is cut, outermost frames kept.
const MAX_DEPTH = 128;
// Distinct stacks one trace keeps; the rest are counted as one "(other)" frame, so a profile stays small.
const MAX_STACKS = 2000;
// How long the profiler runs on with no trace profiled, ready for the next one.
const IDLE_MS = 30_000;
// A profiler running this long is started anew once no trace is profiled: its own samples pile up meanwhile.
const RENEW_MS = 60_000;
// V8's own entries: the loop waiting (no work to profile), and the root every stack starts from.
const IDLE = "(idle)";
const ROOT = "(root)";
const OTHER: ProfileFrame = { function: "(other)", module: null, file: "", line: 0, in_app: false };

/** A frame as the profile names it, once: by its function, file and line. */
function frameKey(frame: ProfileFrame): string {
  return `${frame.file}:${frame.line}:${frame.function}`;
}

/** What a request asks for: the profile ("1"), or the profile with its memory ("memory"). */
export type Asked = "1" | "memory";

/** What a value asks for: "1" or "memory" as they are, true (a span marked by code) "1"; else nothing. */
export function asking(value: unknown): Asked | undefined {
  if (value === true || value === "1") return "1";
  return value === "memory" ? "memory" : undefined;
}

/**
 * Why a trace is profiled: the `profile` setting, a request's X-Tracepanel-Profile header (a person's, or a tool's),
 * the panel's cookie, the header on a call from another app's profiled trace (it carries a traceparent too: a
 * backend's call, the browser's), or the app's own code (profile(), or a root span it marks with tracepanel.profile).
 */
export type Reason = "setting" | "header" | "cookie" | "parent" | "code";

/** What a request asks for, and how; undefined when it asks nothing. */
export interface Ask {
  asked: Asked;
  reason: Reason;
}

/**
 * What a request asks for: the X-Tracepanel-Profile header's (from another app's profiled trace when a traceparent
 * came with it), else the cookie's the panel's toggle sets; undefined when neither asks.
 */
export function asks(headers: RequestHeaders): Ask | undefined {
  const fromHeader = asking(headerValue(headers[HEADER])?.trim());
  if (fromHeader) return { asked: fromHeader, reason: headerValue(headers.traceparent) ? "parent" : "header" };
  const cookies = headerValue(headers.cookie);
  if (cookies?.includes(COOKIE) !== true) return undefined;
  const fromCookie = asking(parseCookies(cookies).find(([name]) => name === COOKIE)?.[1]);
  return fromCookie ? { asked: fromCookie, reason: "cookie" } : undefined;
}

/** What a request asks for (asks() without how). */
export function requested(headers: RequestHeaders): Asked | undefined {
  return asks(headers)?.asked;
}

/** A root span's attributes for what a request asks: none when it asks nothing. */
export function askAttributes(ask: Ask | undefined): Record<string, string> {
  return ask ? { [ATTRIBUTE]: ask.asked, [REASON_ATTRIBUTE]: ask.reason } : {};
}

const REASONS = new Set<unknown>(["setting", "header", "cookie", "parent", "code"]);

/** A reason as a span or a context holds it; undefined for anything else. */
export function reasonOf(value: unknown): Reason | undefined {
  return REASONS.has(value) ? (value as Reason) : undefined;
}

/**
 * How to profile a trace: "memory" with its memory, "1" its time only; undefined for none. The setting profiles
 * every one, a request may ask; nothing when profiling is off.
 */
export function wanted(config: Config, asked: Asked | undefined): Asked | undefined {
  if (!(config.profileEnabled && (config.profile || asked) && available())) return undefined;
  return (config.profileMemory || asked === "memory") && memoryAvailable() ? "memory" : "1";
}

/** Whether this runtime can profile: Node, with its inspector. */
export function available(): boolean {
  return inspector() !== null;
}

/** Whether this runtime can profile memory too: Node's inspector, and V8's GC profiler. */
export function memoryProfiling(): boolean {
  return available() && memoryAvailable();
}

interface CpuProfile {
  nodes: { id: number; callFrame: CallFrame; children?: number[] }[];
  startTime: number;
  samples?: number[];
  timeDeltas?: number[];
}

/** One trace's profile while it runs: its console profile's title, and when it started (performance.now()). */
export interface Recording {
  title: string;
  startedMs: number;
  /** The trace it profiles, as the profiler knows every trace of the process (see enter()). */
  trace: object;
  /** Its memory, when that was asked for. */
  heap: Heap | undefined;
}

/** The trace's profile and the samples left out because another trace ran at the same time. */
export interface Result {
  profile: Profile | undefined;
  dropped: number;
  /** The collector's runs during the trace, read once Node has told them (after the trace's late spans). */
  gc?: () => Profile["gc"];
}

let next = 0;

/** The app's profiler: the profile that runs while traces are profiled, and when each trace of the process ran. */
export class Profiler {
  private session: Session | undefined;
  private running = false;
  private runningSince = 0;
  private idle: NodeJS.Timeout | undefined;
  private readonly recordings = new Set<Recording>();
  /** Every trace of the process running now, and when it started. */
  private readonly open = new Map<object, number>();
  /** Traces that ended while one was profiled: when each started and ended. */
  private ended: [number, number][] = [];
  /** The console profiles stopped, by title, as the inspector hands them over. */
  private readonly finished = new Map<string, CpuProfile>();
  private heaps: HeapSampler | undefined;
  private readonly collections = new Collections();

  constructor(
    private readonly root: string,
    private readonly intervalMs: number,
  ) {}

  /** A trace started (each one, profiled or not): a sample taken while it runs may be its. */
  enter(trace: object): void {
    this.open.set(trace, performance.now());
  }

  /** A trace ended. */
  leave(trace: object): void {
    const started = this.open.get(trace);
    if (started === undefined) return;
    this.open.delete(trace);
    if (this.recordings.size > 0) this.ended.push([started, performance.now()]);
  }

  /**
   * Begins profiling a trace that started (enter() first), its memory too when `memory`; undefined when the
   * inspector can't.
   */
  start(trace: object, memory = false): Recording | undefined {
    const console = inspector()?.console;
    if (!console || !this.ensure()) return undefined;
    clearTimeout(this.idle);
    this.collections.watch();
    next += 1;
    if (memory && this.session && !this.heaps) this.heaps = new HeapSampler(this.session);
    const heap = memory ? this.heaps?.begin() : undefined;
    const recording: Recording = { title: `tracepanel:${next}`, startedMs: performance.now(), trace, heap };
    console.profile(recording.title);
    this.recordings.add(recording);
    return recording;
  }

  /** Profiles the memory of a trace profiled already, from now (profile({ memory: true }) in its code). */
  addMemory(recording: Recording): void {
    if (recording.heap || !this.recordings.has(recording) || !this.session || !memoryAvailable()) return;
    this.heaps ??= new HeapSampler(this.session);
    recording.heap = this.heaps.begin();
  }

  /** Ends a trace's profile, before it leaves: what was sampled while it alone ran. */
  stop(recording: Recording): Result {
    if (!this.recordings.has(recording)) return { profile: undefined, dropped: 0 };
    inspector()?.console.profileEnd(recording.title);
    const endedMs = performance.now();
    // Before it is let go: whether another trace ran while it did.
    const shared = recording.heap ? this.overlapped(recording) : false;
    const measured = recording.heap
      ? this.heaps?.end(recording.heap, (frame) => this.frame(frame) === null)
      : undefined;
    this.recordings.delete(recording);
    const profile = this.finished.get(recording.title);
    this.finished.delete(recording.title);
    const result: Result = profile ? this.document(recording, profile) : { profile: undefined, dropped: 0 };
    if (measured) {
      result.profile ??= { interval_us: Math.round(this.intervalMs * 1000), samples: 0, frames: [], stacks: [] };
      result.profile.memory = this.memory(result.profile, measured.sites, shared, measured);
    }
    if (result.profile) {
      const { startedMs } = recording;
      result.gc = () => this.collections.during(startedMs, endedMs);
    }
    if (this.recordings.size === 0) this.rest();
    else {
      const oldest = Math.min(...[...this.recordings].map((other) => other.startedMs));
      this.ended = this.ended.filter(([, end]) => end >= oldest);
    }
    return result;
  }

  /** The profile that runs under the traces' own: started with the first profiled trace. */
  private ensure(): boolean {
    if (!this.session) {
      const session = connect();
      if (!session) return false;
      try {
        call(session, "Profiler.enable");
        call(session, "Profiler.setSamplingInterval", { interval: Math.round(this.intervalMs * 1000) });
      } catch {
        session.disconnect();
        return false;
      }
      session.on("Profiler.consoleProfileFinished", (message: { params: { title?: string; profile: CpuProfile } }) => {
        const { title, profile } = message.params;
        // Only this profiler's: another session's console.profile() reaches every session.
        if ([...this.recordings].some((recording) => recording.title === title))
          this.finished.set(title ?? "", profile);
      });
      this.session = session;
    }
    if (!this.running) {
      try {
        call(this.session, "Profiler.start");
      } catch {
        return false;
      }
      this.running = true;
      this.runningSince = performance.now();
    }
    return true;
  }

  /** Whether another trace than the recording's ran while it did (the heap is the process's). */
  private overlapped(recording: Recording): boolean {
    for (const trace of this.open.keys()) if (trace !== recording.trace) return true;
    return this.ended.some(([, end]) => end >= recording.startedMs);
  }

  /** The profile's `memory`: its sites' frames added to the profile's own, each once. */
  private memory(
    profile: Profile,
    sites: Site[],
    shared: boolean,
    measured: { peak: number; net: number; allocated?: number },
  ): ProfileMemory {
    const index = new Map(profile.frames.map((frame, at) => [frameKey(frame), at]));
    const named = sites.flatMap((site) => {
      const frames = site.frames.flatMap((callFrame) => {
        const frame = this.frame(callFrame);
        if (!frame) return [];
        const key = frameKey(frame);
        let at = index.get(key);
        if (at === undefined) {
          at = profile.frames.length;
          index.set(key, at);
          profile.frames.push(frame);
        }
        return [at];
      });
      return frames.length > 0 ? [{ frames, bytes: site.bytes, count: site.count }] : [];
    });
    return {
      peak: measured.peak,
      net: measured.net,
      ...(measured.allocated !== undefined ? { allocated: measured.allocated } : {}),
      sites: named,
      sites_at: "end",
      shared,
    };
  }

  /** No trace is profiled: the profile under them stops after a while, or now when it ran long. */
  private rest(): void {
    this.ended = [];
    if (performance.now() - this.runningSince > RENEW_MS) {
      this.halt();
      return;
    }
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.halt(), IDLE_MS);
    this.idle.unref();
  }

  private halt(): void {
    if (!this.session || !this.running || this.recordings.size > 0) return;
    this.running = false;
    this.collections.rest();
    try {
      call(this.session, "Profiler.stop");
    } catch {
      // Stopped already.
    }
  }

  /** Whether another trace than the recording's ran at `at` (performance.now()). */
  private shared(recording: Recording, at: number): boolean {
    for (const [trace, started] of this.open) {
      if (trace !== recording.trace && started <= at) return true;
    }
    return this.ended.some(([started, end]) => started <= at && at <= end);
  }

  /** The trace's `profile`: the functions its stacks name, each once, and each stack as indexes into them. */
  private document(recording: Recording, profile: CpuProfile): Result {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
    const index = new Map<string, number>();
    const frames: ProfileFrame[] = [];
    /** A node's stack as indexes into frames, outermost first; null for the idle loop. */
    const stackOf = new Map<number, number[] | null>();
    const frameIndex = (callFrame: CallFrame): number | null => {
      const key = `${callFrame.url}:${callFrame.lineNumber}:${callFrame.columnNumber}:${callFrame.functionName}`;
      const known = index.get(key);
      if (known !== undefined) return known;
      const frame = this.frame(callFrame);
      if (!frame) return null;
      index.set(key, frames.length);
      frames.push(frame);
      return frames.length - 1;
    };
    const stack = (id: number): number[] | null => {
      const known = stackOf.get(id);
      if (known !== undefined) return known;
      const chain: CallFrame[] = [];
      for (let at: number | undefined = id; at !== undefined; at = parents.get(at)) {
        const node = nodes.get(at);
        if (node && node.callFrame.functionName !== ROOT) chain.push(node.callFrame);
      }
      let found: number[] | null = null;
      if (chain[0]?.functionName !== IDLE) {
        found = [];
        for (const callFrame of chain.reverse()) {
          if (found.length >= MAX_DEPTH) break;
          const at = frameIndex(callFrame);
          if (at !== null) found.push(at);
        }
      }
      stackOf.set(id, found);
      return found;
    };

    const counts = new Map<string, { frames: number[]; count: number }>();
    let samples = 0;
    let dropped = 0;
    let time = profile.startTime;
    const deltas = profile.timeDeltas ?? [];
    (profile.samples ?? []).forEach((id, at) => {
      time += deltas[at] ?? 0;
      let keys = stack(id);
      if (keys === null || keys.length === 0) return;
      // The profile's clock is V8's; it started as the recording did.
      if (this.shared(recording, recording.startedMs + (time - profile.startTime) / 1000)) {
        dropped += 1;
        return;
      }
      let key = keys.join(",");
      if (!counts.has(key) && counts.size >= MAX_STACKS) {
        let other = index.get(OTHER.function);
        if (other === undefined) {
          other = frames.length;
          index.set(OTHER.function, other);
          frames.push(OTHER);
        }
        keys = [other];
        key = String(other);
      }
      const counted = counts.get(key);
      if (counted) counted.count += 1;
      else counts.set(key, { frames: keys, count: 1 });
      samples += 1;
    });
    if (samples === 0) return { profile: undefined, dropped };
    // Only the frames the kept stacks name, in the order the most frequent stacks name them.
    const stacks = [...counts.values()].sort((a, b) => b.count - a.count);
    const kept: ProfileFrame[] = [];
    const renumber = new Map<number, number>();
    for (const counted of stacks) {
      counted.frames = counted.frames.map((frame) => {
        let to = renumber.get(frame);
        if (to === undefined) {
          to = kept.length;
          renumber.set(frame, to);
          kept.push(frames[frame] as ProfileFrame);
        }
        return to;
      });
    }
    return {
      profile: { interval_us: Math.round(this.intervalMs * 1000), samples, frames: kept, stacks },
      dropped,
    };
  }

  /** A function as the profile names it; null for this package's own. */
  private frame(callFrame: CallFrame): ProfileFrame | null {
    const name = callFrame.functionName || "(anonymous)";
    if (!callFrame.url) return { function: name, module: null, file: "", line: 0, in_app: false };
    const found = place(callFrame.url, callFrame.lineNumber + 1, callFrame.columnNumber + 1, name);
    if (ownFile(found.file)) return null;
    const own = inApp(found.file, this.root);
    return {
      // As the source names it, where a minifier renamed it.
      function: found.function || name,
      module: null,
      file: own ? relative(this.root, found.file) : libraryPath(found.file),
      line: found.line,
      in_app: own,
    };
  }
}
