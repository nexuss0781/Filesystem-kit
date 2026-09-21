# FileSystem Kit Live Throughput Benchmark

**Benchmark date:** 2026-09-22  
**Target:** `https://filesystem-kit.wasmer.app`  
**Purpose:** Evaluate whether the deployed filesystem API is responsive and reliable enough for use by an AI coding or research agent.

## Executive result

The live benchmark completed successfully with **300 requests and zero errors**. Every tested operation returned its expected HTTP status, and the test cleaned up all temporary files it created.

The deployment is functionally reliable, but its latency is high for interactive agent use. Most operations took approximately two seconds. The measured throughput was generally between **1.86 and 4.60 requests per second**, depending on the endpoint and concurrency level.

This performance is adequate for a low-volume coding agent that performs targeted, sequential operations. It is not yet optimized for high-volume repository indexing or agents that issue many independent filesystem calls in parallel.

## Test coverage

The benchmark used disposable, non-hidden files in the deployed filesystem. It tested the health endpoint and every filesystem operation exposed by the server:

| Operation | HTTP endpoint | Requests | Concurrency | Expected status |
| --- | --- | ---: | ---: | ---: |
| Health | `GET /health` | 100 | 10 | 200 |
| Write | `PUT /api/write` | 30 | 6 | 201 |
| Read | `GET /api/read` | 30 | 6 | 200 |
| Modify | `PATCH /api/modify` | 30 | 6 | 200 |
| Grep | `GET /api/grep` | 30 | 4 | 200 |
| Glob | `GET /api/glob` | 30 | 4 | 200 |
| List | `GET /api/list` | 20 | 4 | 200 |
| Delete | `DELETE /api/delete` | 30 | 6 | 200 |

The write, read, modify, search, listing, and delete calls were issued as separate HTTP requests. This matters because it validates persistence across request boundaries rather than only testing an in-process sequence.

## Results

| Operation | Successful | Errors | Throughput | Average latency | P50 latency | P95 latency | Maximum latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Health | 100 | 0 | 4.60 req/s | 2,085 ms | 2,068 ms | 2,575 ms | 2,861 ms |
| Write | 30 | 0 | 2.79 req/s | 2,091 ms | 2,073 ms | 2,282 ms | 2,294 ms |
| Read | 30 | 0 | 2.89 req/s | 1,968 ms | 2,010 ms | 2,256 ms | 2,275 ms |
| Modify | 30 | 0 | 2.77 req/s | 2,133 ms | 2,075 ms | 2,338 ms | 2,342 ms |
| Grep | 30 | 0 | 1.86 req/s | 1,986 ms | 2,001 ms | 2,284 ms | 2,292 ms |
| Glob | 30 | 0 | 1.89 req/s | 1,961 ms | 2,002 ms | 2,309 ms | 2,333 ms |
| List | 20 | 0 | 2.02 req/s | 1,953 ms | 2,005 ms | 2,240 ms | 2,240 ms |
| Delete | 30 | 0 | 2.83 req/s | 2,030 ms | 2,034 ms | 2,308 ms | 2,329 ms |

The test result was:

```text
RESULT=PASS total_errors=0
```

## Interpretation for AI agents

The API is suitable for an agent that reads a file, makes a focused change, verifies the change, and then moves to the next file. The endpoint behavior is consistent enough for normal tool-call workflows, and the persistent volume allows separate requests to observe the same files.

The approximately two-second request latency will become noticeable when an agent performs many small operations. An agent that makes 100 sequential calls could spend several minutes waiting on network and platform latency even when the filesystem work itself is trivial.

The most effective optimization is to reduce the number of round trips. A future batch endpoint could accept several reads, writes, or edits in one request. Agents should also use targeted paths instead of repeatedly searching the entire root directory. Read ranges are preferable to reading complete large files when only a section is needed.

The benchmark did not measure maximum capacity, sustained load, large files, conflicting edits, or behavior under instance replacement during an active write. Those scenarios require a separate load test with a defined request budget and file-size profile.

## Operational and security requirements

The endpoint performs filesystem mutations and must not be exposed as an unauthenticated public service for arbitrary users. Before connecting it to an autonomous agent, add authentication, request rate limiting, audit logging, and a maximum request-body size appropriate to the workload.

The path confinement check prevents traversal outside the configured root. It does not provide user-level isolation inside that root. If multiple agents or users share the service, they need separate roots or an authorization layer that maps each identity to an allowed directory.

The Wasmer deployment uses a persistent volume mounted at `/home/ubuntu`. Wasmer documents that files under a mounted volume persist through application crashes, restarts, and updates.[1] The benchmark therefore validates the intended persistent-volume deployment rather than ephemeral instance storage.

## Conclusion

**FileSystem Kit passed the live functional throughput benchmark.** It delivered 300 successful requests with zero errors across all exposed operations. The primary limitation for AI-agent workloads is latency, not correctness. The current deployment is appropriate for moderate, targeted file manipulation and research workflows. Batch operations and stronger access control are recommended before using it for high-volume or multi-tenant agent execution.

## References

[1]: https://docs.wasmer.io/edge/guides/volumes/ "Using persistent storage in Wasmer Edge Apps"
[2]: https://docs.wasmer.io/edge/configuration/ "Wasmer Edge App Configuration"
