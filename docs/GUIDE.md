# Real-Time Conference System — Complete Guide
**Gap Analysis · Build Order · Code Walkthrough · Tests · Pitfalls · Learning Path**

---

## Part 0 — Where You Are Right Now (Honest Gap Analysis)

Your current code (`dummy-webrtc`) is a toy proof-of-concept. Here is what it does vs. what the docs demand:

| Area | What you have | What the docs require |
|---|---|---|
| Signaling server | Dumb broadcast relay — forwards every message to every peer | Authenticated gateway that validates session tokens and writes presence to Redis |
| Session management | Nothing | Full REST API: create/get/terminate sessions, admit/kick participants, grant/revoke permissions |
| Authority model | Nothing | Single Session Manager owns all decisions, writes to Redis before any signaling is allowed |
| Redis | Nothing | Two namespaces: `auth:*` (authority) and `rt:*` (runtime), with retry-until-visible write strategy |
| SFU | Nothing (P2P via signaling relay) | mediasoup v3 with per-participant permission enforcement, 5-second refresh loop |
| ICE/TURN | Hardcoded localhost TURN that doesn't exist | STUN + self-hosted coturn with HMAC-based time-limited credentials |
| Permissions | Nothing | `can_send_audio`, `can_send_video`, `can_receive_media`, `can_send_chat` enforced at SFU level |
| JWT auth | Nothing | Two-layer JWT: user JWT for REST APIs, session JWT for WebSocket signaling |
| Fail-closed | Nothing | Disconnect on any uncertainty — Redis down, permission missing, ICE failed |
| Tests | Nothing | Needed at unit, integration, and chaos levels |

The gap is large but completely learnable. The good news: your `transport.js` and `signaling.server.js` show you understand the WebRTC basics. Everything else is building the authority system around that core.

---

## Part 1 — Build Order (Step by Step)

Do these in order. Each step depends on the previous one. Do NOT skip ahead.

### Step 1 — Redis first (no code, just understanding)

Install Redis locally. Run `redis-cli`. Play with these exact commands until they feel natural:

```bash
# Store a session
HSET auth:sess:sess_001:meta created_by user_xyz status active

# Read it back (this is the "readback" step in retry-until-visible)
HGET auth:sess:sess_001:meta created_by

# Store participant authority as a JSON blob in a hash field
HSET auth:sess:sess_001:participants part_001 '{"role":"participant","permissions":{"can_send_audio":true}}'

# Read all participants in a session
HGETALL auth:sess:sess_001:participants

# Presence with TTL
SETEX rt:presence:sess_001:part_001 45 '{"connection_id":"conn_xyz"}'

# Check TTL countdown
TTL rt:presence:sess_001:part_001

# Delete everything for a session
DEL auth:sess:sess_001:meta
DEL auth:sess:sess_001:participants
```

**Why first:** Every other component reads or writes Redis. If you don't own the schema in your head, you'll write bugs in every other file.

---

### Step 2 — Session Manager HTTP API (no WebSocket, no SFU)

Create `server/session-manager.js`. Implement these endpoints in this order:

1. `POST /v1/sessions` — create session, write to Redis with retry-until-visible
2. `GET /v1/sessions/:id` — read from Redis
3. `POST /v1/sessions/:id/join` — admit participant, write authority, issue session JWT
4. `POST /v1/sessions/:id/leave` — remove from Redis
5. `DELETE /v1/sessions/:id` — terminate (creator only)
6. `POST /v1/sessions/:id/participants/:pid/revoke` — update permissions in Redis
7. `POST /v1/sessions/:id/participants/:pid/grant` — same
8. `POST /v1/sessions/:id/participants/:pid/kick` — delete participant authority

**Test each one with curl before moving on.** No browser, no WebSocket. Just curl.

```bash
# Create session
curl -X POST http://localhost:3000/v1/sessions \
  -H "Authorization: Bearer YOUR_JWT" \
  -H "Content-Type: application/json" \
  -d '{"max_participants": 5}'

# Admit yourself
curl -X POST http://localhost:3000/v1/sessions/sess_abc/join \
  -H "Authorization: Bearer YOUR_JWT"
```

The prototype.js in your docs already has `writeAuthority`, `POST /sessions`, and `POST /sessions/:id/join`. Start from there.

**The one thing to get right:** The session JWT you issue on join must NOT contain permissions. Permissions live only in Redis. The JWT just proves identity. This is explicitly stated in the docs and easy to get wrong.

---

### Step 3 — Signaling Gateway (WebSocket, but still no SFU)

Create `server/gateway.js`. This replaces your current `signaling.server.js`.

The current code does this:

```javascript
// BAD: blind broadcast, no auth, no Redis
wss.on("connection", (socket) => {
  peers.add(socket);
  socket.on("message", (msg) => {
    for (const peer of peers) {
      if (peer !== socket) peer.send(msg); // forwards to EVERYONE
    }
  });
});
```

The gateway must do this instead:

```javascript
// 1. Client connects with: wss://...?token=SESSION_JWT
// 2. Gateway verifies the token (JWT signature + expiry)
// 3. Gateway checks Redis: does this session exist? is participant admitted?
// 4. Only then: accept the connection
// 5. Write presence to Redis: SETEX rt:presence:sess:part 45 {...}
// 6. Start heartbeat: refresh presence every 30s
// 7. On disconnect: delete presence key
```

Message routing: When a client sends an SDP offer `{type:"offer", sdp:"..."}`, the gateway does NOT broadcast it. It forwards to the SFU only. When the SFU produces an answer, the gateway sends it back to that specific client only. This is point-to-point, not broadcast.

---

### Step 4 — mediasoup SFU (the hardest part)

Install mediasoup: `npm install mediasoup`

Create `server/sfu.js`. This is where media actually flows.

The SFU has three jobs:

**Job 1: Accept SDP offers and produce answers**
```javascript
// When gateway forwards an offer from client:
const transport = await router.createWebRtcTransport({...});
const producer = await transport.produce({ kind: 'audio', rtpParameters });
// Send answer back through gateway
```

**Job 2: Permission enforcement on Producer creation**
```javascript
// Before creating a Producer:
const data = await redis.hGet(`auth:sess:${sessionId}:participants`, participantId);
const { permissions } = JSON.parse(data);

if (trackKind === 'audio' && !permissions.can_send_audio) {
  // FAIL CLOSED: reject, disconnect
  return;
}
```

**Job 3: Permission refresh loop every 5 seconds**
```javascript
setInterval(async () => {
  for (const [participantId, { producers }] of activeSessions) {
    const data = await redis.hGet(`auth:sess:${sessionId}:participants`, participantId);
    
    if (!data) {
      // Redis error or participant kicked — FAIL CLOSED
      disconnectParticipant(participantId);
      return;
    }
    
    const { permissions } = JSON.parse(data);
    
    if (!permissions.can_send_audio) {
      for (const producer of producers.audio) {
        await producer.close(); // stops media immediately
      }
    }
  }
}, 5000);
```

**Start mediasoup before the signaling gateway.** The gateway needs a reference to the SFU to forward offers to it.

---

### Step 5 — Client (browser side)

Update `client/transport.js` to work with the authenticated system:

```javascript
// OLD (your current code)
export function createTransport({ signalingUrl }) {
  const ws = new WebSocket(signalingUrl); // no auth

// NEW
export function createTransport({ signalingUrl, sessionToken }) {
  const ws = new WebSocket(`${signalingUrl}?token=${sessionToken}`); // auth
```

Before connecting WebSocket, the client must call `POST /v1/sessions/:id/join` via REST to get the session token. Then use that token for WebSocket. The docs are explicit: **authority precedes connectivity**.

Also update unmute logic:
```javascript
// When adding a track back (unmute):
async function unmute() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const track = stream.getAudioTracks()[0];
  
  // Authority check BEFORE addTrack
  const permissions = await fetchCurrentPermissions(); // GET /sessions/:id → check Redis
  if (!permissions.can_send_audio) {
    track.stop();
    showError("You don't have permission to send audio");
    return;
  }
  
  pc.addTrack(track, stream); // triggers renegotiation
}
```

---

### Step 6 — ICE/TURN

Set up coturn locally for development:

```bash
# Ubuntu
sudo apt install coturn

# /etc/turnserver.conf
listening-port=3478
fingerprint
lt-cred-mech
use-auth-secret
static-auth-secret=YOUR_HMAC_SECRET
realm=conference.local
```

Generate time-limited credentials in your Session Manager (issued with the session token):

```javascript
function generateTurnCredentials(participantId) {
  const ttl = 24 * 3600;
  const username = `${Math.floor(Date.now()/1000) + ttl}:${participantId}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET)
    .update(username)
    .digest('base64');
  return { username, credential };
}
```

Include these in the join response so the client can configure `RTCPeerConnection.iceServers`.

---

## Part 2 — Code Walkthrough (Every File, Every Concept)

### `server/session-manager.js` — The Authority Owner

This file is the most important file in the entire system. Everything else defers to it.

```javascript
// The core principle in code form:
async function writeAuthority(redisClient, key, field, value) {
  // We don't just write to Redis and hope for the best.
  // We write, then read back to verify it's visible.
  // This is "retry-until-visible" — the system's guarantee
  // that signaling cannot start before authority is persisted.
  
  for (let attempt = 0; attempt < 5; attempt++) {
    await redisClient.hSet(key, field, value);
    const readback = await redisClient.hGet(key, field);
    
    if (readback === value) return; // confirmed visible
    
    await sleep(100); // 100ms between retries
  }
  
  // After 5 attempts (500ms total), give up.
  // Surface the error — never silently continue.
  throw new Error('Authority write failed: not visible after retries');
}
```

Why does this matter? Because between the write and the SFU's first permission check, there's a window. If Redis has a transient issue, the write might appear to succeed but not be readable. By reading back immediately, we catch this before the client is told they're admitted.

The JWT issued on join:
```javascript
// Note what's MISSING: permissions are NOT in the token
const sessionToken = jwt.sign({
  sub: participantId,
  session_id: sessionId,
  user_id: req.userId,
  role: 'participant',
  // NO permissions here — permissions come from Redis only
}, SECRET, { expiresIn: '24h' });
```

If permissions were in the JWT, you couldn't revoke them without invalidating the token. By keeping permissions only in Redis, the Session Manager can update them instantly (enforced within 5s by the SFU).

---

### `server/gateway.js` — Connectivity, Not Authority

```javascript
wss.on('connection', async (socket, req) => {
  // Step 1: Extract token from query string
  const url = new URL(req.url, 'ws://localhost');
  const token = url.searchParams.get('token');
  
  // Step 2: Verify JWT signature and expiry
  let payload;
  try {
    payload = jwt.verify(token, SECRET);
  } catch {
    socket.close(1008, 'Invalid token'); // 1008 = Policy Violation
    return; // FAIL CLOSED
  }
  
  // Step 3: Check Redis — is this session still active?
  const sessionMeta = await redis.hGet(
    `auth:sess:${payload.session_id}:meta`, 'data'
  );
  if (!sessionMeta || JSON.parse(sessionMeta).status !== 'active') {
    socket.close(1008, 'Session not found');
    return;
  }
  
  // Step 4: Check Redis — is this participant still admitted?
  const participantData = await redis.hGet(
    `auth:sess:${payload.session_id}:participants`,
    payload.sub
  );
  if (!participantData) {
    socket.close(1008, 'Participant not admitted');
    return;
  }
  
  // Step 5: Write presence (runtime state, not authority)
  const connectionId = `conn_${Date.now()}`;
  await redis.setEx(
    `rt:presence:${payload.session_id}:${payload.sub}`,
    45, // TTL in seconds
    JSON.stringify({ connection_id: connectionId, connected_at: Date.now() })
  );
  
  // Step 6: Heartbeat — refresh presence every 30s
  const heartbeatInterval = setInterval(async () => {
    await redis.expire(`rt:presence:${payload.session_id}:${payload.sub}`, 45);
  }, 30000);
  
  // Step 7: Send connected confirmation
  socket.send(JSON.stringify({
    type: 'connected',
    connection_id: connectionId,
    participant_id: payload.sub,
    session_id: payload.session_id
  }));
  
  socket.on('close', () => {
    clearInterval(heartbeatInterval);
    redis.del(`rt:presence:${payload.session_id}:${payload.sub}`);
  });
  
  socket.on('message', (raw) => {
    const msg = JSON.parse(raw);
    
    if (msg.type === 'offer') {
      // Forward to SFU — gateway does NOT process SDP itself
      sfu.handleOffer(payload.session_id, payload.sub, msg.sdp, (answer) => {
        socket.send(JSON.stringify({ type: 'answer', sdp: answer }));
      });
    }
    
    if (msg.type === 'ice-candidate') {
      sfu.addIceCandidate(payload.session_id, payload.sub, msg.candidate);
    }
    
    if (msg.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
    }
  });
});
```

The key thing to internalize: the gateway **never** decides admission, never reads permissions to decide routing, never modifies authority state. It just validates identity and relays messages. This separation is what makes the system debuggable.

---

### `server/sfu.js` — The Enforcement Point

The SFU is where media permissions become real. Everything else is data. Here's where it actually stops packets.

```javascript
// Simplified mediasoup setup
const worker = await mediasoup.createWorker();
const router = await worker.createRouter({
  mediaCodecs: [
    { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
    { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
    { kind: 'video', mimeType: 'video/H264', clockRate: 90000 }
  ]
});

// Per session: track all producers and transports
const sessions = new Map(); // sessionId → { participants: Map }

async function handleOffer(sessionId, participantId, sdpOffer) {
  // 1. Check permission BEFORE creating producer
  const rawData = await redis.hGet(
    `auth:sess:${sessionId}:participants`, participantId
  );
  
  if (!rawData) {
    // Redis error — FAIL CLOSED
    throw new Error('Cannot verify permissions');
  }
  
  const { permissions } = JSON.parse(rawData);
  
  // 2. Create transport
  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: process.env.ANNOUNCED_IP }],
    enableUdp: true,
    enableTcp: true,
  });
  
  await transport.connect({ dtlsParameters: parsedFromOffer.dtlsParameters });
  
  // 3. Create producers only for permitted tracks
  const producers = {};
  
  if (parsedFromOffer.audioTrack && permissions.can_send_audio) {
    producers.audio = await transport.produce({
      kind: 'audio',
      rtpParameters: parsedFromOffer.audioRtpParameters
    });
  } else if (parsedFromOffer.audioTrack) {
    // Has audio track but no permission — reject silently
    // Client will be notified via permission-revoked WS message
  }
  
  // Store producers for the refresh loop
  if (!sessions.has(sessionId)) sessions.set(sessionId, { participants: new Map() });
  sessions.get(sessionId).participants.set(participantId, { transport, producers });
  
  // Return answer SDP
  return router.createAnswer(transport);
}

// THE CRITICAL LOOP
setInterval(async () => {
  for (const [sessionId, session] of sessions) {
    for (const [participantId, participant] of session.participants) {
      
      let rawData;
      try {
        rawData = await redis.hGet(
          `auth:sess:${sessionId}:participants`, participantId
        );
      } catch (err) {
        // Redis read failed — FAIL CLOSED
        disconnectParticipant(sessionId, participantId, 'redis_error');
        continue;
      }
      
      if (!rawData) {
        // Participant was kicked or session terminated
        disconnectParticipant(sessionId, participantId, 'not_found');
        continue;
      }
      
      const { permissions } = JSON.parse(rawData);
      
      // Enforce audio permission
      if (!permissions.can_send_audio && participant.producers.audio) {
        participant.producers.audio.close();
        delete participant.producers.audio;
        // Gateway notifies client via WebSocket
        gateway.notifyClient(participantId, {
          type: 'permission-revoked',
          permissions: ['can_send_audio'],
          reason: 'revoked by moderator'
        });
      }
      
      // Same for video
    }
  }
}, 5000);
```

---

### `client/transport.js` — ICE States and What They Mean

```javascript
pc.oniceconnectionstatechange = () => {
  switch (pc.iceConnectionState) {
    case 'checking':
      // Candidates being exchanged, normal
      break;
      
    case 'connected':
      // At least one candidate pair works — media can flow
      showStatus('Connected');
      break;
      
    case 'failed':
      // All candidates tried, none worked
      // Per docs: FAIL CLOSED, no auto-retry
      showStatus('Connection failed. Please rejoin.');
      cleanupAndExit();
      break;
      
    case 'disconnected':
      // Network blip — wait 10s before giving up
      setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') {
          // Still disconnected after 10s → treat as failed
          cleanupAndExit();
        }
      }, 10000);
      break;
  }
};

// ICE candidate queue — critical for trickle ICE
// Candidates can arrive before setRemoteDescription completes
const candidateQueue = [];
let remoteDescriptionSet = false;

ws.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  
  if (msg.type === 'answer') {
    await pc.setRemoteDescription(msg.sdp);
    remoteDescriptionSet = true;
    
    // Drain queued candidates now that remote description is set
    for (const candidate of candidateQueue) {
      await pc.addIceCandidate(candidate);
    }
    candidateQueue.length = 0;
  }
  
  if (msg.type === 'ice-candidate') {
    if (!remoteDescriptionSet) {
      // Queue it — can't add candidate without remote description
      candidateQueue.push(msg.candidate);
    } else {
      await pc.addIceCandidate(msg.candidate);
    }
  }
  
  if (msg.type === 'permission-revoked') {
    // SFU stopped forwarding. Update UI.
    if (msg.permissions.includes('can_send_audio')) {
      muteUI(); // show mic icon as muted
    }
  }
  
  if (msg.type === 'kicked') {
    showError(`You were removed: ${msg.reason}`);
    ws.close();
    // Do NOT reconnect — code 1008 means stay out
  }
};
```

---

## Part 3 — Tests (Brutal and Real)

### Test 1 — Redis Authority is Written Before Join Returns

```javascript
// test/session-manager.test.js
test('join: authority must be visible in Redis before 200 response', async () => {
  // Create session
  const session = await request(app)
    .post('/v1/sessions')
    .set('Authorization', `Bearer ${userJwt}`)
    .send({ max_participants: 5 });
  
  // Join
  const join = await request(app)
    .post(`/v1/sessions/${session.body.session_id}/join`)
    .set('Authorization', `Bearer ${userJwt}`);
  
  expect(join.status).toBe(200);
  
  // Immediately check Redis — must be visible RIGHT NOW
  const raw = await redis.hGet(
    `auth:sess:${session.body.session_id}:participants`,
    join.body.participant_id
  );
  
  expect(raw).not.toBeNull(); // FAILS if write-before-return isn't enforced
  
  const data = JSON.parse(raw);
  expect(data.permissions.can_send_audio).toBe(true);
});
```

### Test 2 — Session JWT Does NOT Contain Permissions

```javascript
test('session token must not contain permissions', async () => {
  const join = await request(app)
    .post(`/v1/sessions/${sessionId}/join`)
    .set('Authorization', `Bearer ${userJwt}`);
  
  const payload = jwt.decode(join.body.token);
  
  // This is the exact contract from the API docs
  expect(payload.permissions).toBeUndefined();
  expect(payload.can_send_audio).toBeUndefined();
  
  // But it must have identity fields
  expect(payload.sub).toBeDefined(); // participant_id
  expect(payload.session_id).toBeDefined();
  expect(payload.role).toBeDefined();
});
```

### Test 3 — Permission Revocation Reflects in Redis Immediately

```javascript
test('revoke: Redis updated before 200 returns', async () => {
  // Setup: admit participant with full permissions
  await admitParticipant(sessionId, participantId);
  
  // Revoke
  const revoke = await request(app)
    .post(`/v1/sessions/${sessionId}/participants/${participantId}/revoke`)
    .set('Authorization', `Bearer ${creatorJwt}`)
    .send({ permissions: ['can_send_audio'] });
  
  expect(revoke.status).toBe(200);
  
  // Redis must reflect the revocation NOW, not eventually
  const raw = await redis.hGet(
    `auth:sess:${sessionId}:participants`, participantId
  );
  const data = JSON.parse(raw);
  
  expect(data.permissions.can_send_audio).toBe(false);
  expect(data.permissions.can_send_video).toBe(true); // untouched
});
```

### Test 4 — SFU Refresh Loop Closes Producers on Revocation

```javascript
test('sfu: producer closed within 6s of permission revocation', async () => {
  jest.useFakeTimers();
  
  const sfu = createSFU({ redis, refreshInterval: 5000 });
  
  // Start a fake producer
  sfu.addFakeProducer(sessionId, participantId, 'audio');
  
  // Revoke permission directly in Redis (simulating Session Manager)
  await revokePermissionInRedis(sessionId, participantId, 'can_send_audio');
  
  // Advance time past one refresh cycle
  jest.advanceTimersByTime(6000);
  await flushPromises();
  
  // Producer must be gone
  expect(sfu.hasProducer(sessionId, participantId, 'audio')).toBe(false);
  
  jest.useRealTimers();
});
```

### Test 5 — Gateway Rejects WebSocket with Expired Token

```javascript
test('gateway: rejects connection with expired JWT', async () => {
  // Create a token that expired 1 hour ago
  const expiredToken = jwt.sign(
    { sub: 'part_001', session_id: 'sess_001', user_id: 'user_001', role: 'participant' },
    SECRET,
    { expiresIn: '-1h' } // already expired
  );
  
  await expect(
    new Promise((_, reject) => {
      const ws = new WebSocket(`ws://localhost:8080/v1/signaling?token=${expiredToken}`);
      ws.on('close', (code, reason) => {
        if (code === 1008) reject(new Error(`Closed: ${reason}`));
      });
    })
  ).rejects.toThrow();
});
```

### Test 6 — Chaos: Redis Goes Down During Active Session

```javascript
test('chaos: SFU disconnects participants after 3 redis failures', async () => {
  const mockRedis = createMockRedis();
  const sfu = createSFU({ redis: mockRedis, refreshInterval: 1000 });
  
  // Set up active session
  sfu.addFakeProducer(sessionId, participantId, 'audio');
  
  // Make Redis fail on all reads
  mockRedis.hGet = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
  
  // Track disconnections
  const disconnected = [];
  sfu.on('participant-disconnected', (pid) => disconnected.push(pid));
  
  // After 3 failures (3 refresh cycles = 3s), participant must be disconnected
  await waitFor(4000);
  
  expect(disconnected).toContain(participantId);
});
```

### Test 7 — Cannot Kick Session Creator

```javascript
test('kick: cannot kick session creator', async () => {
  const res = await request(app)
    .post(`/v1/sessions/${sessionId}/participants/${creatorParticipantId}/kick`)
    .set('Authorization', `Bearer ${moderatorJwt}`)
    .send({ reason: 'test' });
  
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('invalid_operation');
  expect(res.body.message).toMatch(/Cannot kick session creator/);
});
```

### Test 8 — Session Full Returns 403

```javascript
test('join: returns 403 when session is at max_participants', async () => {
  // Fill the session
  const session = await createSession({ max_participants: 2 });
  await joinSession(session.session_id, userA);
  await joinSession(session.session_id, userB);
  
  // Third person gets rejected
  const res = await joinSession(session.session_id, userC);
  
  expect(res.status).toBe(403);
  expect(res.body.error).toBe('session_full');
});
```

### Test 9 — Reconnect Does NOT Re-Admit (Transport Only)

```javascript
test('reconnect: uses existing participant_id, does not re-admit', async () => {
  const join = await joinSession(sessionId, userId);
  const originalParticipantId = join.body.participant_id;
  
  // Simulate disconnect and reconnect (same token)
  await simulateWebSocketDisconnect(originalParticipantId);
  
  // Reconnect with the same session token (not a new join)
  const reconnected = await connectWebSocket(join.body.token);
  
  // Must be the same participant identity
  expect(reconnected.participant_id).toBe(originalParticipantId);
  
  // Authority in Redis must be unchanged
  const rawData = await redis.hGet(
    `auth:sess:${sessionId}:participants`, originalParticipantId
  );
  expect(rawData).not.toBeNull(); // still admitted
});
```

### Test 10 — Write Authority Retry on Transient Redis Failure

```javascript
test('writeAuthority: retries on transient read failure', async () => {
  let callCount = 0;
  const flakyRedis = {
    hSet: jest.fn().mockResolvedValue(true),
    hGet: jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.resolve(null); // fail first 2 reads
      return Promise.resolve(JSON.stringify({ role: 'participant' })); // succeed on 3rd
    })
  };
  
  await writeAuthority(flakyRedis, 'auth:sess:001:participants', 'part_001', JSON.stringify({ role: 'participant' }));
  
  expect(callCount).toBe(3); // retried until visible
});
```

---

## Part 4 — Common Pitfalls (and How to Avoid Them)

**Pitfall 1: Putting permissions in the session JWT**

Easy to do because "it's convenient." Breaks permission revocation entirely. A revoked permission needs to be enforced within 5 seconds. If it's in the JWT, you'd need to invalidate the token — which requires a token revocation list — which you don't have. Keep permissions only in Redis.

**Pitfall 2: Trusting ICE `disconnected` state as final**

The state machine goes: `connected → disconnected → connected` on a network blip. If you close the connection immediately on `disconnected`, users lose their call every time their wifi hiccups. The docs say: start a 10-second timer, only close if still `disconnected` after 10s.

**Pitfall 3: Adding ICE candidates before setRemoteDescription**

This is the classic trickle ICE race. The browser will throw `InvalidStateError` if you call `addIceCandidate` before `setRemoteDescription`. Always queue candidates if remote description isn't set yet.

**Pitfall 4: Not setting `noeviction` on Redis**

Redis's default eviction policy will start deleting your authority keys when memory fills up. A deleted authority key looks to the SFU exactly like a kicked participant — so it will disconnect people. Set `maxmemory-policy noeviction` in your redis.conf so writes fail noisily instead of silently deleting data.

**Pitfall 5: Forgetting the presence TTL is a liveness mechanism**

If you set `rt:presence:*` with TTL 45s but only refresh every 60s, the key expires between refreshes and everyone looks offline. The docs say: set TTL to 45s, refresh every 30s. The ratio matters — refresh interval must be less than TTL.

**Pitfall 6: SFU crashes = everyone must rejoin, not just reconnect**

When mediasoup crashes, all in-memory transport state is gone. The WebRTC negotiation (SDP, ICE credentials, DTLS) lives in the SFU process. There's nothing to reconnect to. The authority in Redis is fine — participants are still admitted — but they need a fresh SDP exchange, which means a full rejoin flow. Don't confuse users with "reconnecting..." when they actually need to hit "rejoin."

**Pitfall 7: Session Manager writing to Redis without readback**

A single `await redis.hSet(key, field, value)` can succeed (Redis acknowledged the write) but the data can still not be visible on a subsequent read in certain failure conditions. The retry-until-visible pattern exists for this reason. Skip it and you'll have rare, unreproducible bugs where someone appears to join but can't do anything because the SFU can't find their permissions.

**Pitfall 8: cors in development**

Your signaling gateway will reject WebSocket upgrades from the browser if the Origin header doesn't match. During development: `new WebSocketServer({ port, verifyClient: () => true })` to disable origin checks. In production: whitelist your client origin.

**Pitfall 9: Safari getUserMedia requires user gesture**

In Safari, `navigator.mediaDevices.getUserMedia` will reject with `NotAllowedError` if called without a user gesture (a click). Your `transport.start()` call must be triggered by a button click, not automatically on page load.

**Pitfall 10: Not handling Blob vs string in ws.onmessage**

Your existing code already handles this (you have the `instanceof Blob` check with `.text()`). Keep it. The browser WebSocket API returns messages as Blob in some contexts and string in others depending on `binaryType`. Never assume one or the other.

---

## Part 5 — Learning Path (Playing with Every Line)

Here's how to learn by deliberately breaking things.

### Experiment 1: Break and fix Redis readback

In `writeAuthority`, comment out the readback:
```javascript
await redisClient.hSet(key, field, value);
// const readback = await redisClient.hGet(key, field);  // COMMENT OUT
return; // return immediately
```

Now run `redis-server --port 6380 --save ""` (in-memory, no persistence). Make it so reads fail 50% of the time by intercepting calls. Watch what happens. Uncomment the readback. Watch it recover. This teaches you exactly why the pattern exists.

### Experiment 2: Change the permission refresh interval

Change the SFU refresh from 5000ms to 500ms. Run your test suite. Watch Redis CPU spike. Change it to 30000ms (30s). Revoke someone's audio permission. Watch them keep talking for 30 seconds. Now you've felt why 5s is the compromise.

### Experiment 3: Put permissions in the JWT (deliberately wrong)

Temporarily change your join handler to include permissions in the JWT. Write a test that revokes audio permission. Verify the SFU stops the producer (it will, because the SFU reads Redis not the JWT). Then write a client that extracts permissions from the JWT and uses those to decide whether to show the mic button. Watch the UI say "muted" while the SFU still allows audio. That's the security hole. Now remove permissions from the JWT.

### Experiment 4: Reconnect race

Start a session with a participant. Revoke their audio permission. Immediately have them "reconnect" (close WebSocket, reopen with same token within 5 seconds, before the SFU refresh cycle). Do they get audio back briefly? They should (the old producer is still active until the refresh loop fires). This is the "bounded 5-second enforcement delay" the docs accept. You've now felt the trade-off in your hands.

### Experiment 5: ICE failure modes

Block UDP on your machine (Linux: `iptables -A OUTPUT -p udp --dport 19302 -j DROP`). Watch STUN fail. Watch your connection fall through to TURN relay. Block TCP too. Watch it fail entirely. Observe the ICE state machine. Unblock. Now you understand why the candidate preference order matters.

### Experiment 6: Authority reconstruction after Session Manager restart

Create a session, admit two participants. Kill the Session Manager process. Bring it back. The Session Manager code should read from Redis to rebuild its state. Write a test that proves a POST /sessions/:id/join to the restarted server returns 200 (session still exists in Redis). If it returns 404, your server isn't reading from Redis on startup.

---

## Final Checklist Before You Say It's Done

- [ ] POST /v1/sessions/:id/join writes to Redis before returning 200
- [ ] Session JWT does NOT contain permissions
- [ ] Gateway validates token AND checks Redis before accepting WebSocket
- [ ] Gateway writes presence with 45s TTL, refreshes every 30s
- [ ] SFU reads permissions from Redis when creating producers (not from JWT)
- [ ] SFU has a 5-second refresh loop that closes producers on revocation
- [ ] SFU disconnects participants after 3 consecutive Redis read failures
- [ ] ICE candidate queue implemented (drains after setRemoteDescription)
- [ ] ICE `disconnected` has 10s grace period before treating as `failed`
- [ ] Client calls REST join before opening WebSocket (authority precedes connectivity)
- [ ] Redis configured with `maxmemory-policy noeviction`
- [ ] Presence keys have TTL, not authority keys
- [ ] Cannot kick session creator (403)
- [ ] Cannot kick yourself (403)
- [ ] Session full returns 403 with `session_full` error code
- [ ] All 10 tests above passing

---

*Build in the order given. Test each step with curl before moving to the next. The system is only as correct as its Redis writes.*
