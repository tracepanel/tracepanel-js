// The local variables of an error's frames, as the Python SDK keeps them: the app's own frames only, each value as
// text, cut short, the ones under a sensitive name masked. They never leave this machine.
//
// JavaScript can't look into a frame once an error left it, so the inspector stops the app as the error is thrown,
// while its frames are still there, and reads them: Debugger.setPauseOnExceptions, in a session of the app's own
// thread, which handles the pause before the throw goes on. Only while a trace runs (no pause outside one: the
// startup's module loading throws by the hundred), only an Error thrown inside a trace, at most MAX_PAUSES a second;
// a pause costs about a millisecond. An error is read where it is first thrown: its frames that run then, not
// the callers that were waiting on an `await` (those have no locals here). A process run under a debugger
// (--inspect) is left alone: its pauses would stop the debugger too.

import { inspect, types } from "node:util";
import { maskText } from "./dumps.js";
import { call, connect, inspector, type Session } from "./inspector.js";
import { MASK, sensitive } from "./request.js";
import { asyncFrames, inApp, parseStack, type StackFrame } from "./stack.js";

// At most this many local variables of a frame, and the app's frames of an error, have their values kept.
const MAX_LOCALS = 40;
const MAX_FRAMES = 50;
// Pauses on errors in a second; past it, errors are thrown without one until the second is over.
const MAX_PAUSES = 50;
// Errors whose locals are kept until their trace records them, by their stack.
const MAX_ERRORS = 100;
// A value as text: a container's items cut as Python's reprlib cuts them, and the whole as long as this at most; any
// other object this long at most.
const MAX_REPR = 1000;
const MAX_OTHER = 160;
const INSPECT = { depth: 2, maxArrayLength: 10, maxStringLength: 160, breakLength: Number.POSITIVE_INFINITY };
// The scopes that are the frame's own, innermost first: its blocks and catch clauses, then its body.
const OWN_SCOPES = new Set(["block", "local", "catch", "with"]);
// The hook the paused app calls with what the debugger hands over, one for each reader.
let readers = 0;

/** The local variables of an error's frames, by the frame's place in its stack (innermost first). */
export type FrameLocals = (Record<string, string> | undefined)[];

interface CallFrame {
  functionName: string;
  location: { lineNumber: number };
  scopeChain: { type: string; object: { objectId?: string } }[];
}

interface Paused {
  reason: string;
  data?: { subtype?: string; objectId?: string; description?: string };
  callFrames: CallFrame[];
}

/**
 * A value as the console shows it, as Python's reprlib cuts one: a plain object, an array, a Map or a Set by its
 * items, nested two deep, ten of each at most; anything else (a class's instance: a request, a connection) and a
 * string at most 160 characters. Masked under a sensitive name, and a value under a key that names a secret inside it
 * (`{ password: '********' }`), from inspect()'s text: a proxy is shown as inspect() shows it, without its traps.
 */
export function repr(name: string, value: unknown): string {
  if (sensitive(name)) return MASK;
  try {
    // On one line: inspect() lays a long array out in rows.
    const text = maskText(inspect(value, INSPECT)).replace(/\s*\n\s*/g, " ");
    const limit = container(value) ? MAX_REPR : MAX_OTHER;
    return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
  } catch {
    return `<unrepresentable ${typeof value}>`;
  }
}

function container(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (value === null || typeof value !== "object" || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    Array.isArray(value) ||
    prototype === Object.prototype ||
    prototype === null ||
    value instanceof Map ||
    value instanceof Set
  );
}

/** A frame's variables as text, from its scope objects, innermost first: an inner name hides an outer one. */
export function variables(scopes: object[]): Record<string, string> {
  const found: Record<string, string> = {};
  let count = 0;
  for (const scope of scopes) {
    for (const name of Object.keys(scope)) {
      if (count >= MAX_LOCALS) return found;
      // V8's own (.generator_object), and Python's rule for dunder names.
      if (name in found || name.startsWith(".") || name.startsWith("__")) continue;
      found[name] = repr(name, (scope as Record<string, unknown>)[name]);
      count += 1;
    }
  }
  return found;
}

/**
 * Whether a frame of the stack is the one the debugger has: on the same line, or of the same name. A stack mapped
 * through source maps (--enable-source-maps, a TypeScript loader) has the source's lines, the debugger the code's.
 */
function same(frame: StackFrame, callFrame: CallFrame): boolean {
  if (callFrame.location.lineNumber + 1 === frame.line) return true;
  const name = frame.function.replace(/^new /, "").split(".").at(-1);
  return callFrame.functionName !== "" && name === callFrame.functionName;
}

/**
 * Errors Next.js throws to steer a render rather than to fail it: redirect(), notFound() and the other HTTP
 * fallbacks, a dynamic or client-side bail-out, a prerender's hanging promise. Each starts its stack with its message,
 * the code Next.js checks for. They are thrown on ordinary requests, so they are not read and spend no pause budget.
 */
const STEERING =
  /^(?:\w*Error: )?(?:NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK;|Dynamic server usage: |Bail out to client-side rendering: |During prerendering, )|^StaticGenBailoutError\b/;

/** Whether an error, by its stack, is one Next.js throws to steer a render. */
export function steers(stack: string): boolean {
  return STEERING.test(stack);
}

/** Reads the locals of errors thrown in a trace, for its errors to carry. */
export class Locals {
  private tracing = false;
  private limited = false;
  private second = 0;
  private pauses = 0;
  private state = "none";
  /** The objects the hook was passed. */
  private received: object[] | undefined;
  /**
   * What was read, by the error's stack (its trace records that), and the trace it was thrown in. Thrown again in the
   * same trace, an error keeps its first throw's.
   */
  private readonly errors = new Map<string, { trace: string; locals: FrameLocals }>();
  private readonly hookName = `tracepanel.locals.${++readers}`;

  private constructor(
    private readonly session: Session,
    private readonly root: string,
    private readonly traceId: () => string | undefined,
  ) {}

  /** The reader, with the inspector's debugger on; undefined where there is none, or a debugger is attached. */
  static start(root: string, traceId: () => string | undefined): Locals | undefined {
    if (inspector()?.url()) return undefined;
    const session = connect();
    if (!session) return undefined;
    const locals = new Locals(session, root, traceId);
    try {
      call(session, "Debugger.enable");
    } catch {
      session.disconnect();
      return undefined;
    }
    (globalThis as Record<symbol, unknown>)[Symbol.for(locals.hookName)] = (args: object[]) => {
      locals.received = args;
    };
    session.on("Debugger.paused", (message: { params: Paused }) => {
      try {
        locals.paused(message.params);
      } catch {
        // Whatever went wrong, the app goes on as if nothing paused it.
      }
    });
    return locals;
  }

  /** Whether a trace runs: errors pause only then. */
  traces(running: boolean): void {
    this.tracing = running;
    this.pauseOn(running && !this.limited ? "all" : "none");
  }

  /** The locals read for the error with this stack, taken: each error's are given once. */
  take(stack: string | undefined): FrameLocals | undefined {
    if (!stack) return undefined;
    const found = this.errors.get(stack);
    this.errors.delete(stack);
    return found?.locals;
  }

  private pauseOn(state: "all" | "none"): void {
    if (state === this.state) return;
    this.state = state;
    try {
      call(this.session, "Debugger.setPauseOnExceptions", { state });
    } catch {
      // The debugger went away: nothing pauses.
    }
  }

  /** At most MAX_PAUSES a second: past them, no pause until the second is over. */
  private budget(): boolean {
    const now = performance.now();
    if (now - this.second >= 1000) {
      this.second = now;
      this.pauses = 0;
    }
    this.pauses += 1;
    if (this.pauses <= MAX_PAUSES) return true;
    this.limited = true;
    this.pauseOn("none");
    setTimeout(
      () => {
        this.limited = false;
        this.pauseOn(this.tracing ? "all" : "none");
      },
      Math.max(1000 - (now - this.second), 1),
    ).unref();
    return false;
  }

  /** The objects of these ids, handed over by the paused app: called on `objectId`, the hook is passed them. */
  private objects(objectId: string, ids: string[]): object[] | undefined {
    this.received = undefined;
    call(this.session, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (...args) { globalThis[Symbol.for("${this.hookName}")](args); }`,
      arguments: ids.map((id) => ({ objectId: id })),
      silent: true,
    });
    return this.received;
  }

  private paused(event: Paused): void {
    if (event.reason !== "exception" && event.reason !== "promiseRejection") return;
    const { objectId, description: stack } = event.data ?? {};
    if (event.data?.subtype !== "error" || !objectId || !stack || steers(stack) || !this.budget()) return;
    const trace = this.traceId();
    // The inspector describes an error by its stack. Read already in this trace, it is the same error thrown again on
    // its way up.
    if (trace === undefined || this.errors.get(stack)?.trace === trace) return;
    const wanted = this.frames(stack, event.callFrames);
    if (wanted.length === 0) return;
    const scopes = this.objects(
      objectId,
      wanted.flatMap(({ scopes }) => scopes),
    );
    if (!scopes) return;
    const found: FrameLocals = [];
    let at = 0;
    for (const frame of wanted) {
      found[frame.index] = variables(scopes.slice(at, at + frame.scopes.length));
      at += frame.scopes.length;
    }
    this.errors.delete(stack);
    this.errors.set(stack, { trace, locals: found });
    if (this.errors.size > MAX_ERRORS) this.errors.delete(this.errors.keys().next().value as string);
  }

  /**
   * The app's frames of the error's stack and the scopes of the frames that run them, paired by line or name: both go
   * from the throw outwards. The stack's `async` callers have no frame running; its innermost frame may have none
   * either, an error made in a helper and thrown by its caller. An error thrown again elsewhere (made outside a trace,
   * thrown in one) has another stack than the debugger's: nothing pairs with its first frames, and none is read.
   */
  private frames(stack: string, callFrames: CallFrame[]): { index: number; scopes: string[] }[] {
    const raw = parseStack(stack, false);
    const mapped = parseStack(stack);
    const waiting = asyncFrames(stack);
    const found: { index: number; scopes: string[] }[] = [];
    let next = 0;
    for (const [index, frame] of raw.entries()) {
      if (next === 0 && index > 1) break;
      if (waiting[index] || found.length >= MAX_FRAMES) continue;
      const match = callFrames.slice(next, next + 3).findIndex((callFrame) => same(frame, callFrame));
      if (match < 0 || (next === 0 && match > 0)) continue;
      const callFrame = callFrames[next + match] as CallFrame;
      next += match + 1;
      if (!inApp(mapped[index]?.file ?? "", this.root)) continue;
      const scopes: string[] = [];
      for (const scope of callFrame.scopeChain) {
        if (!OWN_SCOPES.has(scope.type)) break;
        if (scope.object.objectId) scopes.push(scope.object.objectId);
        // The blocks past the function's own scope are around the function, not in it.
        if (scope.type === "local") break;
      }
      found.push({ index, scopes });
    }
    return found;
  }
}
