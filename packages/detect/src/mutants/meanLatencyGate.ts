// MUTANT. Models: gating CI on latency, using a mean.
//
// Two mistakes at once, and both are extremely common because both are what a reasonable person
// does first. Latency is the easiest metric to collect and the one everyone reaches for, and the
// mean is the obvious summary.
//
// Measured on this machine, a single free-form case produced eight latencies of which one was 3.57
// times the median. That one sample moves the mean by more than any drift this tool is trying to
// find. And a baseline captured weeks ago is being compared against today's network, today's
// provider load and today's routing, none of which the tool observes. A build that fails for those
// reasons is a build whose failures nobody can act on.
//
// The injected change is one line: latency is treated as a gating metric.

import { type Detector, referenceDetector } from "../detector.js";

export const meanLatencyGate: Detector = {
  name: "M4 meanLatencyGate",
  compare: (cases, baseline, candidate, options) => {
    const real = referenceDetector.compare(cases, baseline, candidate, options);
    if (real.verdict === "NOT_COMPARABLE") return real;
    const latency = real.findings.find((f) => f.metric === "latencyMs");
    // THE BUG: a latency increase fails the build.
    const slower = latency !== undefined && latency.effect > 0.1;
    if (!slower) return real;
    return {
      ...real,
      verdict: "CONFIRMED_DRIFT",
      reason: "mean latency increased",
      confirmedMetrics: ["latencyMs"],
      findings: real.findings.map((f) => (f.metric === "latencyMs" ? { ...f, gating: true } : f)),
    };
  },
  watchRound: referenceDetector.watchRound,
};
