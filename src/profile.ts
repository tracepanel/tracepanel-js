// Where a trace's time goes in code: V8's sampling profiler, through Node's inspector (the trace's `profile`, a flame
// graph in the console). Nothing runs until a trace is profiled: the setting profiles every one, a request asks with
// the X-Tracepanel-Profile: 1 header or the panel's tracepanel_profile=1 cookie.
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
import type { Profile, ProfileFrame } from "./model.js";
import { headerValue, parseCookies, type RequestHeaders } from "./request.js";
import { inApp, libraryPath, ownFile, place } from "./stack.js";

export const HEADER = "x-tracepanel-profile";
export const COOKIE = "tracepanel_profile";
/** On a request's root span: the request asked to be profiled. */
export const ATTRIBUTE = "tracepanel.profile";
/** In the context a framework starts the request's root span in (Next.js's): the request asked to be profiled. */
export const ASKED = createContextKey("tracepanel.profile");

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

/** Whether a request asks to be profiled: the X-Tracepanel-Profile header, or the cookie the panel's toggle sets. */
export function requested(headers: RequestHeaders): boolean {
  if (headerValue(headers[HEADER])?.trim() === "1") return true;
  const cookies = headerValue(headers.cookie);
  return (
    cookies?.includes(COOKIE) === true &&
    parseCookies(cookies).some(([name, value]) => name === COOKIE && value === "1")
  );
}

/** Whether to profile a trace: the setting profiles every one, a request may ask; nothing when profiling is off. */
export function wanted(config: Config, asked: boolean): boolean {
  return config.profileEnabled && (config.profile || asked) && available();
}

/** Whether this runtime can profile: Node, with its inspector. */
export function available(): boolean {
  return inspector() !== null;
}

interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
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
}

/** The trace's profile and the samples left out because another trace ran at the same time. */
export interface Result {
  profile: Profile | undefined;
  dropped: number;
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

  /** Begins profiling a trace that started (enter() first); undefined when the inspector can't. */
  start(trace: object): Recording | undefined {
    const console = inspector()?.console;
    if (!console || !this.ensure()) return undefined;
    clearTimeout(this.idle);
    next += 1;
    const recording = { title: `tracepanel:${next}`, startedMs: performance.now(), trace };
    console.profile(recording.title);
    this.recordings.add(recording);
    return recording;
  }

  /** Ends a trace's profile, before it leaves: what was sampled while it alone ran. */
  stop(recording: Recording): Result {
    if (!this.recordings.has(recording)) return { profile: undefined, dropped: 0 };
    inspector()?.console.profileEnd(recording.title);
    this.recordings.delete(recording);
    const profile = this.finished.get(recording.title);
    this.finished.delete(recording.title);
    const result = profile ? this.document(recording, profile) : { profile: undefined, dropped: 0 };
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
    const found = place(callFrame.url, callFrame.lineNumber + 1, callFrame.columnNumber + 1);
    if (ownFile(found.file)) return null;
    const own = inApp(found.file, this.root);
    return {
      function: name,
      module: null,
      file: own ? relative(this.root, found.file) : libraryPath(found.file),
      line: found.line,
      in_app: own,
    };
  }
}
