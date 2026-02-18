# Design Review Prep - Honest Questions

## What I'm confident about:
- Fail-closed philosophy (this is the right call)
- Single Session Manager for V1 (simplicity wins)
- Redis for hot path (fast reads critical)

## What I'm uncertain about:
- Is 5s permission refresh too slow? Should it be 3s?
- Should we add Postgres for audit logs in V1 or wait?
- Is manual Redis failover acceptable or do we need Sentinel now?

## Known limitations I'm accepting:
- No simulcast (adds complexity, V1 doesn't need it)
- Single SFU (can't scale >50 sessions, acceptable for phase 1)
- 5min data loss window on Redis crash (RDB snapshots)

## Trade-offs I made:
- Chose synchronous admission over async (simpler client, worth the latency)
- Chose track replacement over sender.replaceTrack (easier to debug)
- Chose WebSocket over polling (better latency, all browsers support)

## If I had more time:
- Add Prometheus metrics
- Add end-to-end tests
- Add load testing harness
- Document WebSocket reconnect strategy better
```

Add margin notes to printed docs:
```
// On architecture doc, next to "fail-closed":
"Debated fail-open but correctness > availability for V1"

// On Redis schema:
"Considered Postgres but 20ms reads too slow for SFU"

// On 5s refresh:
"Tested 3s but Redis load 2x higher, 5s feels right"
```

---

## **FINAL DOC STRUCTURE**

Your final package:
```
/v1/
  ├── 00_ARCHITECTURE-CONDENSED.md (300 lines) ← CORE
  ├── 01_Runtime-Flow-Join.md (100 lines)
  ├── 02_Runtime-Flow-Media-Attach.md (100 lines)
  ├── 03_Runtime-Flow-Reconnect.md (100 lines)
  ├── 04_Runtime-Flow-Revocation.md (100 lines)
  ├── 05_API-Wire-Contracts.md (complete) ← CRITICAL
  ├── 06_WebRTC-Implementation.md (new) ← CRITICAL
  ├── 07_Redis-Schema-Ops.md (new) ← CRITICAL
  ├── 08_Failure-Playbook.md (new)
  ├── 09_Design-Decisions.md (new)
  ├── 10_Infra-Execution-Model.md (keep existing)
  ├── 11_Non-Goals.md (keep existing)
  └── REVIEWER-NOTES.md (new)

/prototype/
  ├── server.js (Session Manager)
  ├── gateway.js (WebSocket signaling)
  ├── sfu.js (mediasoup stub)
  ├── client.html (WebRTC client)
  ├── package.json
  └── README.md (how to run)