```

Then also create:
- `prototype/gateway-stub.js` (WebSocket signaling)
- `prototype/sfu-permission-check.js` (mediasoup permission enforcement)
- `prototype/client-stub.html` (simple WebRTC client)

This proves you can ACTUALLY BUILD IT.

---

## **TIER 2: SMILE-INDUCERS (6 hours)**

### **5. Failure Scenario Playbook (3 hours)**

Create `/v1/12_Failure-Scenario-Playbook.txt`
```
DOC 12 — Failure Scenario Playbook (Operational)
Real-Time Conference System

Status: Normative (Operations Manual)
Audience: SRE, on-call engineers, design reviewers
Depends on: DOC 3 (Failure Semantics), DOC 7 (Infra Model)

--------------------------------------------------

1. Purpose

This document provides step-by-step playbooks for handling production failures.

Each scenario includes:
- Symptoms (how you detect it)
- Root cause (what's actually broken)
- Immediate action (stop the bleeding)
- Recovery steps (fix it)
- Prevention (don't let it happen again)

This is the doc you open at 3am.

--------------------------------------------------

2. Scenario 1: Redis Connection Lost

Symptoms:
- Logs: "Redis ECONNREFUSED" or "Redis timeout"
- Metrics: redis_connection_errors spiking
- User impact: New joins fail with 500 errors

Root cause analysis:
1. Check Redis process: `systemctl status redis`
2. Check network: `ping redis-host`
3. Check Redis logs: `tail -f /var/log/redis/redis.log`

Immediate action:
1. Restart Redis: `systemctl restart redis`
2. If restart fails: Check disk space, check memory

Expected recovery time: 30 seconds

User impact during outage:
- New joins: FAIL (503 Service Unavailable)
- Existing sessions: CONTINUE (permissions cached in SFU)
- Permission changes: FAIL (cannot write to Redis)

Recovery steps:
1. Verify Redis is up: `redis-cli PING` → should return PONG
2. Verify key count: `redis-cli DBSIZE` → should show session data
3. Monitor admission success rate (should recover within 1 minute)

Post-mortem:
- If Redis crashed: Check logs for OOM or disk full
- If network issue: Check firewall rules
- If repeated: Consider Redis Sentinel for auto-failover (V2)

Prevention:
- Monitor Redis memory usage (alert at 75%)
- Monitor disk space (alert at 80%)
- Set up Redis persistence (RDB snapshots)

--------------------------------------------------

3. Scenario 2: SFU Crashes

Symptoms:
- Logs: SFU process exit
- Metrics: active_media_streams drops to zero
- User impact: All video freezes, audio cuts out

Root cause analysis:
1. Check SFU process: `systemctl status mediasoup`
2. Check SFU logs: Last error before crash
3. Common causes:
   - Segfault (mediasoup bug)
   - OOM (too many participants)
   - Unhandled promise rejection (code bug)

Immediate action:
1. Restart SFU: `systemctl restart mediasoup`
2. Announce to users: "Service interruption, please rejoin"

Expected recovery time: 10 seconds (SFU startup)

User impact:
- All media: STOPS immediately
- Participants: Disconnected
- Sessions: Still exist (authority in Redis intact)
- Users must: Rejoin session (not just reconnect)

Recovery steps:
1. Verify SFU started: Check logs for "Worker started"
2. Verify Redis connection: SFU should log "Redis connected"
3. Test join: Create test session, verify media works

Post-mortem:
- Analyze core dump (if segfault)
- Check memory usage before crash (if OOM)
- Review code changes (if promise rejection)

Prevention:
- Set max participants per session (10 for V1)
- Monitor SFU memory usage
- Set up process restart on crash (systemd Restart=always)

--------------------------------------------------

4. Scenario 3: Permission Revocation Not Enforced

Symptoms:
- User reports: "I muted someone but they're still talking"
- Logs: No errors
- Metrics: permission_refresh_failures = 0

Root cause analysis:
- SFU permission refresh delay (expected behavior)
- Check last refresh time: Should be within 5 seconds

Immediate action:
1. This is NOT a bug (expected bounded delay)
2. Explain to user: "Enforcement happens within 5 seconds"
3. If >10s delay: Check SFU Redis connection

Expected enforcement time: Within 5 seconds

Workaround (if urgent):
1. Kick participant entirely (immediate)
2. They can rejoin without problematic permission

Long-term fix:
- V2: Consider WebSocket push for instant enforcement
- V1: 5s delay is acceptable (documented trade-off)

--------------------------------------------------

5. Scenario 4: Session State Corrupted

Symptoms:
- Session Manager fails to reconstruct authority on restart
- Logs: "Authority reconstruction failed: missing participant data"
- User impact: Participants kicked from session

Root cause analysis:
1. Partial Redis write (authority_write retry failed)
2. Manual Redis key deletion (operator error)
3. Redis eviction (unlikely with noeviction policy)

Immediate action:
1. DO NOT try to guess missing data
2. Invalidate session: DELETE auth:sess:{session_id}:*
3. Inform users: "Session corrupted, please create new session"

Expected recovery time: Manual (users rejoin new session)

Recovery steps:
1. Verify Redis persistence is working
2. Check for other corrupted sessions: Scan all session keys
3. If widespread: Restore from RDB snapshot

Post-mortem:
- Review authority write logs (did retries exhaust?)
- Check for code bugs (incomplete writes)
- Audit manual Redis access (who deleted keys?)

Prevention:
- Never manually delete authority keys in production
- Monitor authority_write_failure metrics
- Consider Redis AOF for better durability (V2)

--------------------------------------------------

6. Scenario 5: ICE Connection Failures Spike

Symptoms:
- Metrics: ice_failure_total increasing
- User reports: "Can't join, stuck on connecting"
- Logs: Client-side "ICE failed" errors

Root cause analysis:
1. Check TURN server: `systemctl status coturn`
2. Check TURN logs: `/var/log/coturn/turn.log`
3. Check network: Firewall blocking UDP/TCP?

Common causes:
- TURN server down
- TURN credentials expired
- Firewall rule change
- ISP blocking WebRTC ports

Immediate action:
1. Restart TURN server: `systemctl restart coturn`
2. Verify ports open: `netstat -tuln | grep 3478`
3. Test TURN: Use Trickle ICE test page

Expected recovery time: 1 minute

User impact:
- Users behind symmetric NAT: Cannot connect
- Users with direct IP: Unaffected
- Workaround: None (must fix TURN)

Recovery steps:
1. Verify TURN working: Generate test credentials, try connection
2. Check TURN allocation count: `turnadmin -l` (if coturn)
3. Monitor ice_failure rate (should drop)

Prevention:
- Monitor TURN server health (process, CPU, network)
- Set up TURN credential rotation (every 24h)
- Have backup TURN server (V2)

--------------------------------------------------

7. Scenario 6: Session Quota Exhausted

Symptoms:
- Metrics: Redis memory usage > 95%
- Logs: "OOM command not allowed when used memory"
- User impact: Cannot create new sessions

Root cause analysis:
1. Too many active sessions (leak?)
2. Sessions not cleaned up on termination
3. Redis maxmemory too low

Immediate action:
1. Delete old sessions manually:
```
   redis-cli KEYS auth:sess:* | while read key; do
     TTL=$(redis-cli HGET "$key" created_at)
     # Delete if older than 24h
   done
```

2. Increase Redis memory (if needed): Edit redis.conf, restart

Expected recovery time: 5 minutes (manual cleanup)

Recovery steps:
1. Verify memory usage dropped
2. Verify new sessions can be created
3. Monitor for leaks (memory should stabilize)

Post-mortem:
- Audit session cleanup logic (are terminated sessions deleted?)
- Check for zombie sessions (created but never joined)
- Review maxmemory setting (4GB enough for 5000 sessions)

Prevention:
- Implement session TTL (delete after 24h inactive)
- Monitor active session count (alert if >100)
- Auto-cleanup job (runs hourly)

--------------------------------------------------

8. Quick Reference: First Actions by Symptom

| Symptom | First Action | Doc Reference |
|---------|--------------|---------------|
| "Can't join" | Check Redis connection | Scenario 1 |
| "Video frozen" | Check SFU process | Scenario 2 |
| "Mute not working" | Check SFU refresh time | Scenario 3 |
| "Session disappeared" | Check Redis for corruption | Scenario 4 |
| "Connecting forever" | Check TURN server | Scenario 5 |
| "Out of capacity" | Check Redis memory | Scenario 6 |

--------------------------------------------------

End of DOC 12
```

---

### **6. Design Decision Log (2 hours)**

Create `/v1/13_Design-Decision-Log.txt`
```
DOC 13 — Design Decision Log (Rationale and Trade-offs)
Real-Time Conference System

Status: Informative
Audience: Design reviewers, future maintainers
Purpose: Explain WHY we made key decisions

--------------------------------------------------

This document records major design decisions and their rationale.
It exists because:
- Future reviewers will ask "why did you do X instead of Y?"
- Trade-offs should be explicit, not implicit
- We want to avoid revisiting settled debates

Format per decision:
- Context: What problem were we solving?
- Options considered: What alternatives did we evaluate?
- Decision: What did we choose?
- Rationale: Why?
- Trade-offs accepted: What did we give up?
- Revisit conditions: When should we reconsider?

--------------------------------------------------

Decision 1: Fail-Closed vs Fail-Open Under Uncertainty

Context:
What should the system do when it cannot verify permissions?
(e.g., Redis unreachable, permission data missing)

Options considered:
A) Fail-open: Allow media to continue flowing
B) Fail-closed: Disconnect participant

Decision: Fail-closed

Rationale:
- Correctness over availability (V1 priority)
- Wrong permission grant worse than temporary disconnect
- Easier to debug (failure is visible)
- Industry standard for security-sensitive systems

Trade-offs accepted:
- More user-visible errors
- Lower availability during transient failures
- Users must manually rejoin (not automatic recovery)

Revisit conditions:
- If availability becomes critical (V2+)
- If transient failures are common (>1% of sessions)
- If graceful degradation is valued over correctness

Who decided: Architecture team, 2024-02-01

--------------------------------------------------

Decision 2: Centralized vs Distributed Authority

Context:
Should authority decisions be made by a single Session Manager
or distributed across multiple instances?

Options considered:
A) Single Session Manager (centralized authority)
B) Multi-instance with leader election
C) Distributed consensus (Raft, Paxos)

Decision: Single Session Manager (A)

Rationale:
- V1 scale target: 50 concurrent sessions (fits on one instance)
- Correctness is easier with single writer
- No split-brain scenarios
- Simpler to reason about and debug

Trade-offs accepted:
- No high availability (Session Manager restart = interruption)
- Single point of failure
- Cannot scale horizontally without redesign

Revisit conditions:
- If scale > 100 concurrent sessions
- If 99.9% uptime SLA required
- If multi-region deployment needed

Who decided: Architecture review, 2024-02-03

--------------------------------------------------

Decision 3: Redis vs PostgreSQL for State Store

Context:
What database should store session state?

Options considered:
A) Redis (in-memory, eventually consistent)
B) PostgreSQL (ACID, strongly consistent)
C) Cassandra (distributed, eventually consistent)

Decision: Redis (A)

Rationale:
- Fast reads critical for SFU permission refresh (5s interval)
- PostgreSQL too slow for high-frequency reads (20-50ms latency)
- TTL support for presence heartbeats (built-in)
- Simple ops (single instance for V1)
- Team expertise (backend team knows Redis)

Trade-offs accepted:
- No strong consistency (eventual consistency only)
- Data loss risk on crash (up to 5min with RDB)
- No ACID transactions across keys

Revisit conditions:
- If strong consistency required (unlikely for real-time)
- If audit log needed (add Postgres for audit only)
- If Redis memory costs prohibitive

Who decided: Backend + Infra team, 2024-02-05

Alternatives for specific use cases:
- Could add Postgres for audit logs (authority mutations)
- Keep Redis for hot path (permissions, presence)

--------------------------------------------------

Decision 4: Mediasoup vs Janus vs Custom SFU

Context:
Which SFU implementation to use for media routing?

Options considered:
A) mediasoup (Node.js, TypeScript)
B) Janus (C, plugin-based)
C) Custom SFU (built from scratch)

Decision: mediasoup (A)

Rationale:
- Node.js matches backend stack (code reuse)
- TypeScript support (type safety)
- Production-ready (used by Whereby, Miro)
- Active development (releases every 2-3 months)
- Good documentation and community
- Simpler than building custom (6 month time save)

Trade-offs accepted:
- Node.js overhead (higher memory than C)
- Not lowest latency (Janus is ~10ms faster)
- Tied to mediasoup API design

Revisit conditions:
- If latency <50ms critical (gaming, trading)
- If mediasoup development stalls
- If custom features needed (unlikely for V1)

Who decided: Backend team, 2024-02-08

--------------------------------------------------

Decision 5: Synchronous vs Asynchronous Admission

Context:
Should participant admission be synchronous (wait for Redis write)
or asynchronous (return immediately, poll for result)?

Options considered:
A) Synchronous: Block until authority persisted
B) Asynchronous: Return immediately, client polls

Decision: Synchronous (A)

Rationale:
- Simpler client code (no polling loop)
- Clearer error handling (failure immediate)
- Authority guaranteed visible before client proceeds
- Trade latency for correctness (acceptable for V1)

Trade-offs accepted:
- Higher perceived join latency (100-500ms)
- Client blocked during Redis retry window

Revisit conditions:
- If join latency >1s unacceptable
- If admission requires external API calls (async makes sense)

Who decided: Backend team, 2024-02-10

--------------------------------------------------

Decision 6: Track Replacement vs sender.replaceTrack() for Mute

Context:
How should client implement mute/unmute?

Options considered:
A) Stop/start MediaStreamTrack (replaceTrack())
B) Remove/add track to RTCPeerConnection (renegotiation)

Decision: Remove/add track (B)

Rationale:
- More explicit (easier to debug)
- Easier to enforce permission checks (addTrack can be blocked)
- Matches mental model (mute = track gone)
- replaceTrack() has browser quirks (Safari issues in 2023)

Trade-offs accepted:
- Requires SDP renegotiation (slower, ~500ms)
- More signaling messages

Revisit conditions:
- If instant mute required (<100ms)
- If browser quirks fixed

Who decided: Client team, 2024-02-12

--------------------------------------------------

Decision 7: Trickle ICE vs Vanilla ICE

Context:
Should we implement trickle ICE (send candidates as discovered)
or vanilla ICE (wait for all candidates)?

Options considered:
A) Trickle ICE
B) Vanilla ICE

Decision: Trickle ICE (A)

Rationale:
- 2-3 second faster connection time
- Standard in all modern browsers
- Complexity manageable (well-documented)

Trade-offs accepted:
- More signaling messages
- Race condition handling (candidate before answer)

Revisit conditions:
- If signaling overhead becomes bottleneck (unlikely)

Who decided: Client + backend team, 2024-02-14

--------------------------------------------------

Decision 8: WebSocket vs HTTP Long-Polling for Signaling

Context:
What transport for signaling messages?

Options considered:
A) WebSocket (bidirectional, persistent)
B) HTTP long-polling (fallback-friendly)
C) Server-Sent Events (server → client only)

Decision: WebSocket (A)

Rationale:
- Bidirectional (SDP offer/answer both directions)
- Lower latency than polling (~50ms vs 1s)
- Less overhead (no repeated HTTP handshakes)
- All browsers support WebSocket (IE11 dead)

Trade-offs accepted:
- No fallback for environments that block WebSocket
- Connection management more complex

Revisit conditions:
- If corporate firewalls block WebSocket (add polling fallback)

Who decided: Backend team, 2024-02-15

--------------------------------------------------

Decision 9: Single Redis Instance vs Redis Cluster

Context:
Should we use Redis standalone or cluster mode?

Options considered:
A) Single instance
B) Redis Cluster (sharded)
C) Redis Sentinel (failover)

Decision: Single instance (A) for V1

Rationale:
- V1 scale fits in single instance (4GB memory)
- Simpler ops (no cluster management)
- No split-brain scenarios
- Failover not required (manual restart acceptable)

Trade-offs accepted:
- No automatic failover (downtime on crash)
- Cannot scale beyond single instance memory

Revisit conditions:
- If scale > 5000 sessions (needs sharding)
- If HA required (add Sentinel)

Who decided: Infra team, 2024-02-16

V2 path: Redis Sentinel first (HA), then Cluster if needed (scale)

--------------------------------------------------

Decision 10: Permission Refresh Interval (5 seconds)

Context:
How often should SFU refresh permissions from Redis?

Options considered:
A) 1 second (near-instant enforcement)
B) 5 seconds (balanced)
C) 30 seconds (lazy, lower load)

Decision: 5 seconds (B)

Rationale:
- Acceptable latency for most use cases (mute, kick)
- Lower Redis load than 1s (5x fewer queries)
- Still feels responsive to users
- Matches industry practice (Zoom ~3-5s, Meet ~10s)

Trade-offs accepted:
- Permission changes delayed up to 5s
- Not suitable for latency-critical scenarios

Revisit conditions:
- If instant enforcement required (<1s)
- If Redis load too high (increase to 10s)

Who decided: Backend team, 2024-02-18

Measurement:
- Monitor p99 enforcement latency
- If >10s: investigate (likely Redis issue)

--------------------------------------------------

Decision 11: V1 No Simulcast

Context:
Should V1 support simulcast (multiple resolution layers)?

Options considered:
A) Support simulcast
B) Defer to V2

Decision: Defer to V2 (B)

Rationale:
- Adds significant complexity (SFU layer selection)
- V1 target: 10 participants (fixed resolution adequate)
- Bandwidth savings not critical at small scale
- Can add later without breaking changes

Trade-offs accepted:
- Higher bandwidth usage
- No adaptive quality (640x480 fixed)

Revisit conditions:
- If bandwidth costs prohibitive
- If mobile users common (need lower resolution)
- If scale > 25 participants per session

Who decided: Architecture team, 2024-02-20

--------------------------------------------------

Decision 12: Manual vs Automatic Session Cleanup

Context:
Should terminated sessions be automatically deleted from Redis?

Options considered:
A) Automatic cleanup (cron job)
B) Manual cleanup (operator deletes)
C) TTL-based (auto-expire after 24h)

Decision: TTL-based (C) for V1

Rationale:
- Prevents unbounded growth
- No cron job needed (Redis handles expiry)
- 24h TTL covers "rejoins after disconnect"

Trade-offs accepted:
- Active sessions could expire if >24h (unlikely for V1)

Revisit conditions:
- If long-running sessions common (increase TTL)

Who decided: Backend team, 2024-02-22

Implementation:
- Set TTL on session metadata key
- Extend TTL on session activity (any participant action)

--------------------------------------------------

Open Questions (To Be Decided):

Q1: Should we add rate limiting?
- Context: Prevent abuse (spam session creation)
- Impact: Low (internal users trusted)
- Decision: Defer to V2 unless abuse observed

Q2: Should we support screen sharing in V1?
- Context: Useful feature, but adds track type
- Impact: Medium (requires SFU changes)
- Decision: Defer to V1.1 (minor version)

Q3: Should we log all authority changes?
- Context: Audit trail for compliance
- Impact: Low (add Postgres write on mutations)
- Decision: Not required for V1, add if compliance needed

--------------------------------------------------

End of DOC 13