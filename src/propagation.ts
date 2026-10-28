// What a call to another app carries: the W3C trace context and baggage (OpenTelemetry's own), and, when the trace
// making it is profiled because its request asked (the X-Tracepanel-Profile header, the panel's cookie, a call that
// carried it here), the same ask: X-Tracepanel-Profile: 1, or memory. So the panel's Profile toggle profiles the
// whole chain, the browser's call to a BFF and each service the BFF calls in turn. It goes on exactly the calls that
// carry a traceparent (undici's fetch, node:http and what is built on it, Bun's calls): the propagator is the one they
// all inject with. A trace the `profile` setting profiles asks nothing of the next app, whose own setting decides.

import {
  type Context,
  type TextMapGetter,
  type TextMapPropagator,
  type TextMapSetter,
  trace,
} from "@opentelemetry/api";
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { type Asked, HEADER } from "./profile.js";

/** Whether the carrier has the header already, where it can say: the app's own goes, not this one. */
function hasHeader(carrier: unknown): boolean {
  if (carrier === null || typeof carrier !== "object") return false;
  if (typeof (carrier as Headers).has === "function" && typeof (carrier as Headers).get === "function") {
    return (carrier as Headers).has(HEADER);
  }
  const getHeader = (carrier as { getHeader?: unknown }).getHeader;
  if (typeof getHeader === "function") return getHeader.call(carrier, HEADER) !== undefined;
  return Object.keys(carrier).some((name) => name.toLowerCase() === HEADER);
}

/** X-Tracepanel-Profile on a call made in a trace whose request asked to be profiled. */
export class ProfilePropagator implements TextMapPropagator {
  constructor(private readonly askedBy: (spanId: string) => Asked | undefined) {}

  inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
    const span = trace.getSpan(context);
    const asked = span ? this.askedBy(span.spanContext().spanId) : undefined;
    if (asked && !hasHeader(carrier)) setter.set(carrier, HEADER, asked);
  }

  extract(context: Context, _carrier: unknown, _getter: TextMapGetter): Context {
    // A request's ask is read where its trace starts (profile.ts's requested()).
    return context;
  }

  fields(): string[] {
    return [HEADER];
  }
}

/** OpenTelemetry's default propagators (the W3C trace context and baggage), with the profile's ask beside them. */
export function profilePropagator(askedBy: (spanId: string) => Asked | undefined): TextMapPropagator {
  return new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator(), new ProfilePropagator(askedBy)],
  });
}
