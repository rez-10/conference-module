# System Architecture (Condensed)
**Real-Time Conference System - Phase 1**

---

## 1. System Constitution

### 1.1 Authority Model (THE CORE PRINCIPLE)

**Single Source of Truth:** Session Manager owns all authority decisions:
- Session existence
- Participant admission
- Role assignment
- Permission grants/revocations
- Session termination

**No other component may decide, infer, or reconstruct authority.**

### 1.2 Failure Philosophy

Under failure, the system prioritizes (in order):
1. Authority correctness
2. Media continuity  
3. Admission availability

**Fail-closed behavior is mandatory:** When in doubt, disconnect.

### 1.3 System Architecture

```
┌─────────────────────────────────────────┐
│           Client Layer                  │
│  (Web/Native/SIP clients)               │
└───────┬──────────────────┬──────────────┘
        │ REST/Auth        │ WebRTC/Signaling
        ▼                  ▼
┌────────────────┐  ┌────────────────────┐
│ Session        │  │ Signaling          │
│ Manager        │  │ Gateway            │
│ (Authority)    │  │ (Connectivity)     │
└───────┬────────┘  └─────┬──────────────┘
        │                 │
        │ Write Authority │ Read Authority
        │                 │ Write Presence
        ▼                 ▼
┌─────────────────────────────────────────┐
│     Session State Store (Redis)         │
│     - Authority State (auth:*)          │
│     - Runtime State (rt:*)              │
└────────────┬────────────────────────────┘
             │ Read Permissions
             ▼
       ┌──────────┐
       │   SFU    │
       │ (Media)  │
       └──────────┘
```

### 1.4 State Taxonomy

All state belongs to exactly one category:

| Category | Owner | Characteristics | Loss Behavior |
|----------|-------|-----------------|---------------|
| **Authority** | Session Manager | Persistent, required for correctness | Fail closed |
| **Runtime** | Gateway/SFU | Ephemeral, reflects reality | Treat as disconnect |
| **Transport** | Gateway | Short-lived, negotiation only | Renegotiation required |
| **Observational** | SFU | Best-effort, advisory | Ignored |

**Critical Rule:** Authority is NEVER inferred from runtime/transport/observational state.

---

## 2. Component Responsibilities

### 2.1 Session Manager (Authority Owner)

**Does:**
- Decide admission/rejection
- Assign roles
- Grant/revoke permissions
- Issue session tokens
- Persist authority to Redis

**Does NOT:**
- Route media
- Perform signaling
- Track real-time presence (as source of truth)
- Enforce permissions on packets

### 2.2 Signaling Gateway (Connectivity)

**Does:**
- Relay SDP/ICE messages
- Validate session existence
- Validate participant identity
- Write runtime presence

**Does NOT:**
- Admit/reject participants
- Assign roles
- Grant/revoke permissions
- Infer authority under missing state

### 2.3 SFU (Media Enforcement)

**Does:**
- Route RTP packets
- Enforce permission snapshots
- Periodically refresh permissions (every 5s)
- Disconnect on enforcement ambiguity

**Does NOT:**
- Decide admission
- Assign roles
- Guess permission state
- Continue media under uncertainty

### 2.4 Redis (State Store)

**Does:**
- Reflect authority decisions
- Distribute authority state
- Store runtime/transport state
- Support authority reconstruction

**Does NOT:**
- Decide authority
- Resolve conflicts autonomously
- Provide inferred defaults

---

## 3. Identity & Reconnect Semantics

### 3.1 Identity Hierarchy

```
User Identity (stable across sessions)
  └─> Session Token
       └─> Participant Identity (session-scoped)
            └─> Connection Identity (ephemeral, replaceable)
```

### 3.2 Reconnect Rules

**Reconnect = Transport replacement, NOT re-admission**

- Reconnect replaces Connection Identity only
- Participant Identity remains unchanged
- Authority is revalidated from Redis
- Reconnect may briefly succeed under stale authority
- Enforcement converges within 5 seconds (permission refresh)

**Reconnect CANNOT bypass permission revocation.**

---

## 4. Failure Modes

### 4.1 Redis Unavailable

- **Session Manager:** Cannot admit new participants (503 error)
- **Gateway:** Reject new connections
- **SFU:** Disconnect participants after 3 failed permission checks
- **Existing media:** May continue temporarily (cached permissions)

### 4.2 Session Manager Restart

- Authority reconstructed from Redis
- If reconstruction incomplete/inconsistent → fail closed:
  - Invalidate session
  - Disconnect participants
  - No guessing

### 4.3 SFU Crash

- All media stops immediately
- All participants disconnected
- Clients must rejoin (not just reconnect)
- Authority state unchanged in Redis

### 4.4 Permission Revocation Delay

- Permission revoked by Session Manager
- Authority written to Redis (immediate)
- SFU enforces within 5 seconds (next refresh)
- **Bounded delay is expected and acceptable**

---

## 5. Runtime Flows (Canonical Sequences)

### 5.1 Join & Admit

```
1. Client → Session Manager: POST /sessions/{id}/join (with user JWT)
2. Session Manager validates token, evaluates admission policy
3. Session Manager writes participant authority to Redis (retry-until-visible)
4. Session Manager responds: { participant_id, session_token }
5. Client may now initiate signaling (NOT before)
```

**Authority precedes connectivity.**

### 5.2 Media Attach

```
1. Client → Gateway: WebSocket connect (with session token)
2. Gateway validates session existence, participant identity
3. Client → Gateway: SDP offer
4. Gateway → SFU: Forward offer
5. SFU fetches permissions from Redis
6. SFU creates answer
7. Gateway → Client: SDP answer
8. ICE connectivity checks (client ↔ SFU)
9. Media flows after ICE success
```

**Enforcement snapshot taken at attachment.**

### 5.3 Permission Revocation

```
1. Session Manager writes revoked permission to Redis
2. Client notified via WebSocket (optional, immediate)
3. SFU refreshes permissions from Redis (within 5s)
4. SFU closes affected Producers/Consumers
5. Media stops flowing
```

**Enforcement converges, not instant.**

---

## 6. V1 Execution Model

### 6.1 Deployment

**Single instance of each:**
- Session Manager (Node.js)
- Signaling Gateway (Node.js)
- SFU (mediasoup)
- Redis (standalone, RDB snapshots)

**No horizontal scaling in V1.**

### 6.2 Scale Limits

- Max participants per session: **10**
- Max concurrent sessions: **50**
- Redis memory: **4GB** (80x headroom)
- SFU producers: **100 max**

### 6.3 Accepted Trade-offs

V1 explicitly accepts:
- Manual restarts (no auto-failover)
- Client-visible interruptions
- Explicit rejoin requirements
- 5-second permission enforcement delay
- 5-minute data loss on Redis crash (RDB interval)

---

## 7. Non-Goals (V1)

V1 explicitly excludes:
- Horizontal scaling
- Multi-SFU routing
- Simulcast / SVC
- Strong consistency guarantees
- Automatic failover
- E2E encryption
- Recording / transcription
- Zero-downtime upgrades

---

## 8. Key Design Decisions

### Why Fail-Closed?
- Correctness > availability (V1 priority)
- Wrong permission worse than disconnect
- Easier to debug

### Why Redis?
- Fast reads (SFU needs <10ms permission checks)
- TTL support (for presence heartbeats)
- Simple ops (single instance)
- vs Postgres: Too slow (20-50ms)

### Why mediasoup?
- Node.js (matches stack)
- Production-ready (Whereby, Miro use it)
- Active maintenance
- vs Janus: Harder to extend
- vs Custom: 6 months saved

### Why 5-second permission refresh?
- Acceptable latency for most use cases
- 5x lower Redis load than 1s
- Matches industry (Zoom ~3-5s, Meet ~10s)

### Why synchronous admission?
- Simpler client code (no polling)
- Authority guaranteed visible before signaling
- Trade latency for correctness

---

## 9. Stability

**These principles are FROZEN for V1:**
- Fail-closed philosophy
- Single Session Manager (authority owner)
- State taxonomy (authority vs runtime)
- Admission before connectivity
- Permission refresh interval (5s)

Any change requires explicit architecture review.

---

**End of Condensed Architecture Document**

