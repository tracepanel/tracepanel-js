// Where a profiled trace's memory goes: V8's sampling heap profiler, through Node's inspector (the profile's
// `memory`), and the heap's level from V8's own statistics. Only for a trace that asks for it (a request's "memory",
// or TRACEPANEL_PROFILE_MEMORY=1 for every profiled one).
//
// The sampler takes one allocation in about every SAMPLING_BYTES the code allocates, with its stack, and keeps it
// while the object lives; each sample stands for that many bytes. A trace's sites are the samples taken while it ran
// and still alive at its end, its frames' functions where they are defined: what it allocated and kept
// (`sites_at`: "end"). One sampler runs while any such trace does, and stops with the last one.
//
// Reading the sampler's profile collects the whole heap first (the inspector asks V8 to), so that it holds only
// what lives: each memory-profiled trace ends with a full garbage collection, after its root span ended, and one
// that starts while another runs begins with one too. That is most of what profiling memory costs.
//
// - `peak`: the heap's highest level during the trace, above its level at the start: before each collection during
//   the trace (V8's GC profiler tells), and at the end. Garbage counts until it is collected.
// - `net`: the bytes the trace allocated that still live at its end, as the samples tell (an estimate).
// - `allocated`: what V8 allocated in all meanwhile, where it counts it (Node 26 has total_allocated_bytes).
// - `shared`: another trace ran in the process meanwhile; the heap is the process's, so its numbers are in there too.

import { constants, type PerformanceEntry, PerformanceObserver } from "node:perf_hooks";
import v8 from "node:v8";
import { call, type Session } from "./inspector.js";

/** About one allocation in this many bytes is sampled: V8's default. */
export const SAMPLING_BYTES = 32 * 1024;
/** The sites a profile keeps, largest first. */
export const MAX_SITES = 50;

export interface CallFrame {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
}

interface HeapNode {
  id: number;
  callFrame: CallFrame;
  children?: HeapNode[];
}

interface HeapProfile {
  head: HeapNode;
  samples: { size: number; nodeId: number; ordinal: number }[];
}

/** One trace's memory while it runs: where the heap and the sampler stood at its start. */
export interface Heap {
  /** The samples taken before it started have ordinals up to this one. */
  ordinal: number;
  used: number;
  allocated: number | undefined;
  /** The heap's level before each collection while it runs. */
  collections: InstanceType<typeof v8.GCProfiler>;
}

/** A site as the sampler found it: its frames, outermost first, the bytes they stand for, and the samples. */
export interface Site {
  frames: CallFrame[];
  bytes: number;
  count: number;
}

/** A trace's memory without its frames named: what the profile's `memory` says but its sites' frame indexes. */
export interface Measured {
  peak: number;
  net: number;
  allocated?: number;
  sites: Site[];
}

/** Whether this runtime can tell a trace's memory: V8's GC profiler (Node 18.15 and later), with the inspector. */
export function memoryAvailable(): boolean {
  return typeof v8.GCProfiler === "function";
}

function levels(): { used: number; allocated: number | undefined } {
  const stats = v8.getHeapStatistics() as v8.HeapInfo & { total_allocated_bytes?: number };
  return {
    used: stats.used_heap_size,
    allocated: typeof stats.total_allocated_bytes === "number" ? stats.total_allocated_bytes : undefined,
  };
}

/** The sampling heap profiler of a session, running while traces whose memory is told do. */
export class HeapSampler {
  private sampling = false;
  private readonly live = new Set<Heap>();

  constructor(private readonly session: Session) {}

  /** A trace's memory from now; undefined when the sampler can't start. */
  begin(): Heap | undefined {
    let ordinal = 0;
    try {
      if (this.sampling) {
        // The samples so far are the traces' running already: this one's come after them.
        ordinal = this.profile().samples.reduce((last, sample) => Math.max(last, sample.ordinal), 0);
      } else {
        call(this.session, "HeapProfiler.enable");
        call(this.session, "HeapProfiler.startSampling", { samplingInterval: SAMPLING_BYTES });
        this.sampling = true;
      }
    } catch {
      return undefined;
    }
    const collections = new v8.GCProfiler();
    collections.start();
    const heap = { ordinal, ...levels(), collections };
    this.live.add(heap);
    return heap;
  }

  /** The trace's memory at its end, its sites the largest first; undefined when the sampler stopped meanwhile. */
  end(heap: Heap, own: (frame: CallFrame) => boolean): Measured | undefined {
    if (!this.live.delete(heap)) return undefined;
    const before = heap.collections.stop()?.statistics ?? [];
    // Before the profile is read: reading it collects the whole heap.
    const now = levels();
    let profile: HeapProfile | undefined;
    try {
      // The last trace's stops the sampler: the next one starts it afresh, with no profile to read first.
      profile = this.live.size === 0 ? this.stop() : this.profile();
    } catch {
      // Stopped by someone else's session.
    }
    if (!profile) return undefined;
    const high = before.reduce(
      (most, collection) => Math.max(most, collection.beforeGC.heapStatistics.usedHeapSize),
      now.used,
    );
    const { kept, net } = sites(profile, heap.ordinal, own);
    return {
      peak: Math.max(0, high - heap.used),
      net,
      ...(now.allocated !== undefined && heap.allocated !== undefined
        ? { allocated: Math.max(0, now.allocated - heap.allocated) }
        : {}),
      sites: kept,
    };
  }

  /** The profile so far. V8 collects the whole heap first, so that it holds only what lives. */
  private profile(): HeapProfile {
    return call<{ profile: HeapProfile }>(this.session, "HeapProfiler.getSamplingProfile").profile;
  }

  /** The sampler stops, with its profile (the whole heap collected first, as for profile()). */
  private stop(): HeapProfile {
    this.sampling = false;
    return call<{ profile: HeapProfile }>(this.session, "HeapProfiler.stopSampling").profile;
  }
}

/**
 * The samples taken after `ordinal` by the stack that allocated them, the largest MAX_SITES, and the bytes they all
 * stand for. One whose innermost frame of code (past the runtime's own, such as JSON.parse) is this package's is its
 * own business, and left out.
 */
function sites(
  profile: HeapProfile,
  ordinal: number,
  own: (frame: CallFrame) => boolean,
): { kept: Site[]; net: number } {
  const parents = new Map<number, HeapNode | undefined>();
  const nodes = new Map<number, HeapNode>();
  const pending: [HeapNode, HeapNode | undefined][] = [[profile.head, undefined]];
  while (pending.length > 0) {
    const [node, parent] = pending.pop() as [HeapNode, HeapNode | undefined];
    nodes.set(node.id, node);
    parents.set(node.id, parent);
    for (const child of node.children ?? []) pending.push([child, node]);
  }
  const found = new Map<number, { bytes: number; count: number }>();
  for (const sample of profile.samples) {
    if (sample.ordinal <= ordinal) continue;
    const site = found.get(sample.nodeId) ?? { bytes: 0, count: 0 };
    site.bytes += sample.size;
    site.count += 1;
    found.set(sample.nodeId, site);
  }
  const kept: Site[] = [];
  let net = 0;
  for (const [id, { bytes, count }] of [...found].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const frames: CallFrame[] = [];
    for (let node = nodes.get(id); node && node !== profile.head; node = parents.get(node.id)) {
      frames.push(node.callFrame);
    }
    const code = frames.find((frame) => frame.url !== "" && !frame.url.startsWith("node:"));
    if (frames.length === 0 || (code && own(code))) continue;
    net += bytes;
    if (kept.length < MAX_SITES) kept.push({ frames: frames.reverse(), bytes: Math.round(bytes), count });
  }
  return { kept, net: Math.round(net) };
}

/** The collector's runs while a trace ran: how many, their pauses in all, and each one's (the profile's `gc`). */
export interface Gc {
  collections: number;
  pause_us: number;
  /** [from the trace's start, how long, the generation: 0 young, 1 incremental marking, 2 the whole heap], in µs. */
  pauses: [number, number, number][];
}

// How long a collection is kept after it ran: a trace's are read once its late spans are in.
const KEEP_MS = 10_000;

function generation(kind: number | undefined): number {
  if (kind === constants.NODE_PERFORMANCE_GC_MINOR) return 0;
  if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) return 2;
  return 1;
}

/** The garbage collector's runs, as Node's performance timeline tells them, while traces are profiled. */
export class Collections {
  private observer: PerformanceObserver | undefined;
  /** When each ran and for how long (performance.now() ms), and its generation. */
  private seen: [number, number, number][] = [];

  watch(): void {
    if (this.observer) return;
    try {
      this.observer = new PerformanceObserver((list) => this.note(list.getEntries()));
      this.observer.observe({ entryTypes: ["gc"] });
    } catch {
      this.observer = undefined;
    }
  }

  private note(entries: PerformanceEntry[]): void {
    const oldest = performance.now() - KEEP_MS;
    this.seen = this.seen.filter(([start]) => start >= oldest);
    for (const entry of entries) {
      const detail = (entry as { detail?: { kind?: number } }).detail;
      this.seen.push([entry.startTime, entry.duration, generation(detail?.kind)]);
    }
  }

  rest(): void {
    // Those Node hasn't handed over yet.
    if (this.observer) this.note(this.observer.takeRecords());
    this.observer?.disconnect();
    this.observer = undefined;
  }

  /** The runs that began between `from` and `to` (performance.now() ms), from `from` on. */
  during(from: number, to: number): Gc {
    const pauses = this.seen
      .filter(([start]) => start >= from && start <= to)
      .map(([start, length, generation]): [number, number, number] => [
        Math.round((start - from) * 1000),
        Math.round(length * 1000),
        generation,
      ]);
    return {
      collections: pauses.length,
      pause_us: pauses.reduce((sum, [, length]) => sum + length, 0),
      pauses,
    };
  }
}
