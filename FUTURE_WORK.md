# Future Work

## Diff Endpoint Observability

The parsed pull request Diff endpoint currently uses a telemetry-first design. It deliberately does not use a mutex, semaphore, request queue, response-delivery guard, or in-memory cache. Those controls should be added only if measurements show a concrete problem.

Successful requests currently log:

- `outcome`
- `raw_bytes`
- `response_bytes`
- `files`
- `hunks`
- `lines`
- `parse_millis`
- `dto_millis`
- `serialize_millis`
- `blocking_millis`
- `total_millis`

Failure paths log an outcome and the size and timing fields available at the point of failure. Logs do not include raw diff content or parser-provided input details.

These fields can answer questions such as:

- What are the median, p95, p99, and maximum diff sizes and processing times?
- Does parsing, DTO construction, or serialization dominate CPU time?
- How often do parser or storage limits reject a request?
- Is response amplification from raw diff text to JSON material in practice?
- Are slow requests explained by CPU work or by time outside the measured stages?

### Logging Improvements

Before adding concurrency controls, improve observation as needed:

- Emit JSON logs or export tracing events to a queryable log system instead of relying only on formatted process output.
- Add a request or trace ID so endpoint completion events can be correlated with `tower-http` request traces.
- Record `spawn_blocking` queue delay separately from execution time. `blocking_millis` currently includes queueing and execution, while the individual stage timers measure work after the blocking task starts.
- Add a lightweight atomic in-flight request gauge if request overlap needs to be measured. This can observe concurrency without limiting it.
- Record process RSS or allocator statistics during generated 50,000-line and 100,000-line scenarios if memory, rather than latency, becomes the concern.
- Consider histograms and counters through a metrics or OpenTelemetry backend only when logs become difficult to aggregate reliably.
- Define an explicit retention and sampling policy before increasing event volume.

### Decision Criteria

Use measured distributions and concurrent-request observations to decide whether to add any of the following:

- A bounded `spawn_blocking` admission limit when overlapping parses cause material CPU contention or memory pressure.
- A response-size limit when observed JSON amplification approaches an unsafe process-memory budget.
- A delivery timeout when real slow clients retain significant response memory or other resources.
- A bounded cache when repeated parsing of the same `synced_at` snapshot is common and expensive.

Any such control should include a targeted test and a documented threshold derived from measurements.

### Stage 11 Baseline

The 2026-07-30 release profile exercised the real Axum endpoint with a generated 100,000-line snapshot, gzip negotiation, complete body consumption, and concurrency levels 1, 2, and 4. On the recorded Apple M5 release build, total completion time was approximately 37-45 ms for one request, 53-54 ms for two overlapping requests, and 93-94 ms for four. The complete profiling process, including serial 50,000-line, 100,000-line, header-heavy, and binary scenarios, peaked near 158 MB RSS.

These controlled results do not justify an admission limit, response-size limit, delivery timeout, or cache at the current target scale. They also do not replace production distributions: no deployed usage-log corpus or slow-client sample was available. Continue collecting the existing endpoint timing and size fields. Add an in-flight gauge and queue-delay timing before considering concurrency controls, and measure slow-client retention before considering a delivery timeout. Revisit controls if production overlap materially increases blocking time or process RSS relative to the deployment memory budget.

## Backend Profiling

The backend does not currently include an embedded sampling profiler or profiling endpoint. It has:

- `tracing-subscriber` formatted logging with an environment filter.
- `tower_http::trace::TraceLayer` for HTTP request tracing.
- Manual `Instant` timing for the Diff endpoint's parsing, DTO construction, serialization, blocking-task, and total request phases.

It does not currently have:

- `pprof` integration.
- OpenTelemetry or a metrics exporter.
- Tokio Console instrumentation.
- Allocator or heap profiling integration.
- Persistent aggregation of timing distributions.

### External Profilers

External sampling profilers do not require endpoint-specific instrumentation to identify CPU-heavy functions:

- Linux `perf` can sample the running backend and include work performed by Tokio blocking threads.
- `cargo flamegraph` can produce flame graphs using platform profiling facilities.
- On macOS, use Instruments, `sample`, or a compatible profiler such as Samply; Linux `perf` is not available natively.

For useful Rust call stacks, profile an optimized build with debug symbols. Frame pointers can also improve stack quality:

```sh
CARGO_PROFILE_RELEASE_DEBUG=1 RUSTFLAGS="-C force-frame-pointers=yes" cargo build --release --manifest-path backend/Cargo.toml
```

Sampling profilers answer where CPU time is spent. They do not automatically provide request-aware fields such as raw bytes, semantic line count, endpoint outcome, or p95 parse duration, and they are less useful for time spent waiting on I/O. Keep structured endpoint telemetry for those questions.

CPU profiling also does not explain all memory behavior. If memory becomes the concern, measure RSS and consider an allocator-aware or heap profiler in addition to `perf` or a flame graph.
