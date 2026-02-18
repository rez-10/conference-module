# API Wire Contracts (Complete)
**Real-Time Conference System - Version 1**

Status: Normative  
Audience: Backend engineers, client developers, reviewers  
Purpose: Exact HTTP and WebSocket contracts for implementation

---

## Table of Contents
1. [Common Conventions](#common-conventions)
2. [Session Management APIs](#session-management-apis)
3. [Admission & Join APIs](#admission--join-apis)
4. [Authority Mutation APIs](#authority-mutation-apis)
5. [Signaling APIs (WebSocket)](#signaling-apis-websocket)
6. [Error Responses](#error-responses)
7. [Status Code Summary](#status-code-summary)

---

## Common Conventions

### Base URL
```
Production: https://api.conference.example.com
Development: http://localhost:3000
```

### Authentication
All HTTP requests (except health check) require:
```http
Authorization: Bearer {user_jwt}
Content-Type: application/json
```

User JWT structure:
```json
{
  "sub": "user_abc123",
  "iat": 1710000000,
  "exp": 1710086400
}
```

### Common Response Headers
```http
Content-Type: application/json
X-Request-ID: {uuid}
X-Error-Code: {error_code}  // on errors only
```

### Request ID
All requests should include (optional but recommended):
```http
X-Request-ID: {client_generated_uuid}
```

---

## Session Management APIs

### 1. Create Session

**Endpoint:** `POST /v1/sessions`  
**Auth:** Required (user JWT)

**Request Body:**
```json
{
  "max_participants": 10  // optional, default 10, range 2-50
}
```

**Success Response: 201 Created**
```json
{
  "session_id": "sess_abc123",
  "created_at": 1710000000,
  "created_by": "user_xyz",
  "status": "active",
  "max_participants": 10
}
```

**Error Responses:**

400 Bad Request - Invalid parameters
```json
{
  "error": "invalid_parameter",
  "message": "max_participants must be between 2 and 50",
  "field": "max_participants"
}
```

401 Unauthorized - Missing/invalid JWT
```json
{
  "error": "unauthorized",
  "message": "Invalid or expired token"
}
```

500 Internal Server Error - Redis write failed
```json
{
  "error": "authority_write_failed",
  "message": "Failed to persist session after retries",
  "retry_after": 5
}
```

**Idempotency:** Same X-Request-ID returns same session_id (within 5 minutes)

---

### 2. Get Session

**Endpoint:** `GET /v1/sessions/{session_id}`  
**Auth:** Required

**Success Response: 200 OK**
```json
{
  "session_id": "sess_abc123",
  "status": "active",
  "created_at": 1710000000,
  "created_by": "user_xyz",
  "participant_count": 3,
  "max_participants": 10
}
```

**Error Responses:**

404 Not Found
```json
{
  "error": "session_not_found",
  "message": "Session does not exist or has been terminated"
}
```

---

### 3. Terminate Session

**Endpoint:** `DELETE /v1/sessions/{session_id}`  
**Auth:** Required (must be session creator)

**Request Body:** None

**Success Response: 200 OK**
```json
{
  "session_id": "sess_abc123",
  "status": "terminated",
  "terminated_at": 1710001000
}
```

**Error Responses:**

403 Forbidden - Not session creator
```json
{
  "error": "insufficient_permissions",
  "message": "Only session creator can terminate session"
}
```

404 Not Found - Session doesn't exist

**Idempotency:** Yes (deleting terminated session returns 200)

---

## Admission & Join APIs

### 4. Request Join

**Endpoint:** `POST /v1/sessions/{session_id}/join`  
**Auth:** Required (user JWT)

**Request Body:**
```json
{}  // empty for V1, may include preferences in V2
```

**Success Response: 200 OK**
```json
{
  "status": "admitted",
  "participant_id": "part_456",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_expires_at": 1710086400,
  "permissions": {
    "can_send_audio": true,
    "can_send_video": true,
    "can_receive_media": true,
    "can_send_chat": true
  },
  "role": "participant"
}
```

**Session Token JWT Payload:**
```json
{
  "sub": "part_456",
  "session_id": "sess_abc123",
  "user_id": "user_xyz",
  "role": "participant",
  "iat": 1710000105,
  "exp": 1710086400
}
```
*Note: Token does NOT contain permissions (those come from Redis for enforcement)*

**Error Responses:**

404 Not Found - Session doesn't exist

409 Conflict - Already admitted
```json
{
  "error": "already_admitted",
  "message": "User is already a participant in this session",
  "participant_id": "part_123",
  "token": "eyJ..."
}
```

403 Forbidden - Session full
```json
{
  "error": "session_full",
  "message": "Session has reached maximum participants (10/10)"
}
```

500 Internal Server Error - Authority write failed

**Idempotency:** Same user joining same session returns same participant_id

---

### 5. Leave Session

**Endpoint:** `POST /v1/sessions/{session_id}/leave`  
**Auth:** Required (session token)

**Request Body:**
```json
{
  "participant_id": "part_456"
}
```

**Success Response: 200 OK**
```json
{
  "participant_id": "part_456",
  "status": "left",
  "left_at": 1710001500
}
```

**Error Responses:**

404 Not Found - Participant not in session

**Idempotency:** Yes

---

## Authority Mutation APIs

### 6. Grant Permissions

**Endpoint:** `POST /v1/sessions/{session_id}/participants/{participant_id}/grant`  
**Auth:** Required (must be session creator or moderator)

**Request Body:**
```json
{
  "permissions": ["can_send_audio", "can_send_video"]
}
```

**Success Response: 200 OK**
```json
{
  "participant_id": "part_456",
  "permissions": {
    "can_send_audio": true,
    "can_send_video": true,
    "can_receive_media": true,
    "can_send_chat": true
  },
  "authority_version": 6,
  "updated_at": 1710000500
}
```

**Enforcement Timeline:**
- Redis write: Immediate
- SFU enforcement: Within 5 seconds (next refresh)

**Error Responses:**

403 Forbidden - Insufficient permissions
```json
{
  "error": "insufficient_permissions",
  "message": "Only session creator or moderators can grant permissions"
}
```

404 Not Found - Participant doesn't exist

400 Bad Request - Invalid permission name
```json
{
  "error": "invalid_parameter",
  "message": "Unknown permission: can_fly",
  "field": "permissions",
  "valid_permissions": ["can_send_audio", "can_send_video", "can_receive_media", "can_send_chat"]
}
```

---

### 7. Revoke Permissions

**Endpoint:** `POST /v1/sessions/{session_id}/participants/{participant_id}/revoke`  
**Auth:** Required (must be session creator or moderator)

**Request Body:**
```json
{
  "permissions": ["can_send_audio"]
}
```

**Success Response: 200 OK**
```json
{
  "participant_id": "part_456",
  "permissions": {
    "can_send_audio": false,  // revoked
    "can_send_video": true,
    "can_receive_media": true,
    "can_send_chat": true
  },
  "authority_version": 7,
  "updated_at": 1710000600
}
```

**Enforcement Timeline:**
- Redis write: Immediate
- SFU enforcement: Within 5 seconds (next refresh)

**Error Responses:**
Same as Grant Permissions

---

### 8. Update Role

**Endpoint:** `POST /v1/sessions/{session_id}/participants/{participant_id}/role`  
**Auth:** Required (must be session creator)

**Request Body:**
```json
{
  "role": "moderator"  // "participant" or "moderator"
}
```

**Success Response: 200 OK**
```json
{
  "participant_id": "part_456",
  "role": "moderator",
  "authority_version": 8,
  "updated_at": 1710000700
}
```

**Error Responses:**

400 Bad Request - Invalid role
```json
{
  "error": "invalid_parameter",
  "message": "Unknown role: admin",
  "field": "role",
  "valid_roles": ["participant", "moderator"]
}
```

403 Forbidden - Only creator can assign moderators

---

### 9. Kick Participant

**Endpoint:** `POST /v1/sessions/{session_id}/participants/{participant_id}/kick`  
**Auth:** Required (must be session creator or moderator)

**Request Body:**
```json
{
  "reason": "disruptive behavior"  // optional
}
```

**Success Response: 200 OK**
```json
{
  "participant_id": "part_456",
  "status": "kicked",
  "kicked_at": 1710000800,
  "kicked_by": "part_123"
}
```

**Effect:**
- Participant authority deleted from Redis
- SFU disconnects on next permission check (<5s)
- Participant cannot rejoin (token invalidated)

**Error Responses:**

403 Forbidden - Cannot kick self
```json
{
  "error": "invalid_operation",
  "message": "Cannot kick yourself from session"
}
```

403 Forbidden - Cannot kick creator
```json
{
  "error": "invalid_operation",
  "message": "Cannot kick session creator"
}
```

---

## Signaling APIs (WebSocket)

### Connection

**Endpoint:** `wss://api.conference.example.com/v1/signaling`

**Handshake:**
Client sends session token as query parameter:
```
wss://api.conference.example.com/v1/signaling?token={session_jwt}
```

**Connection Success:**
Server sends after successful auth:
```json
{
  "type": "connected",
  "connection_id": "conn_xyz789",
  "participant_id": "part_456",
  "session_id": "sess_abc123"
}
```

**Connection Failure:**
WebSocket closes with:
- Code: 1008 (Policy Violation)
- Reason: "Invalid token" / "Session not found" / "Participant not admitted"

---

### Message Types (Client → Server)

#### 1. SDP Offer
```json
{
  "type": "offer",
  "sdp": "v=0\no=- 4611731400430051336 2 IN IP4 127.0.0.1\n..."
}
```

**Server Response:**
```json
{
  "type": "answer",
  "sdp": "v=0\no=- 9876543210987654321 2 IN IP4 0.0.0.0\n..."
}
```

#### 2. ICE Candidate
```json
{
  "type": "ice-candidate",
  "candidate": {
    "candidate": "candidate:1 1 UDP 2130706431 192.168.1.100 54321 typ host",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

**Server Response:**
```json
{
  "type": "ice-candidate-ack",
  "candidate_id": "cand_123"
}
```

#### 3. ICE Complete
```json
{
  "type": "ice-candidate",
  "candidate": null  // signals end of candidates
}
```

#### 4. Heartbeat
```json
{
  "type": "ping"
}
```

**Server Response:**
```json
{
  "type": "pong",
  "timestamp": 1710000900
}
```

**Frequency:** Client sends every 30s, server responds within 5s

---

### Message Types (Server → Client)

#### 1. SDP Answer
(see above)

#### 2. ICE Candidate (from SFU)
```json
{
  "type": "ice-candidate",
  "candidate": {
    "candidate": "candidate:2 1 UDP 1694498815 203.0.113.10 3478 typ srflx",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  }
}
```

#### 3. Permission Revoked
```json
{
  "type": "permission-revoked",
  "permissions": ["can_send_audio"],
  "reason": "revoked by moderator",
  "authority_version": 9
}
```

**Client Action:** Stop sending media for revoked permissions

#### 4. Kicked
```json
{
  "type": "kicked",
  "reason": "disruptive behavior",
  "kicked_by": "part_123"
}
```

**Client Action:** Close connection, show UI message, cannot rejoin

#### 5. Session Terminated
```json
{
  "type": "session-terminated",
  "reason": "session ended by creator"
}
```

**Client Action:** Close connection, show UI message

#### 6. Error
```json
{
  "type": "error",
  "error": "signaling_failed",
  "message": "Failed to forward SDP to SFU",
  "retry": false
}
```

---

### WebSocket Close Codes

| Code | Reason | Client Action |
|------|--------|---------------|
| 1000 | Normal closure | Clean exit |
| 1001 | Server going away | Attempt reconnect |
| 1008 | Policy violation | Do not reconnect (token invalid) |
| 1011 | Internal error | Attempt reconnect |

---

## Error Responses

### Standard Error Format

All HTTP errors follow this format:
```json
{
  "error": "machine_readable_code",
  "message": "Human-readable description",
  "field": "parameter_name",  // optional, for validation errors
  "retry_after": 5,  // optional, seconds to wait before retry
  "valid_values": ["option1", "option2"]  // optional, for enum validation
}
```

### Error Codes

#### Identity & Auth
- `unauthorized` - Missing or invalid JWT
- `token_expired` - Token has expired
- `identity_mismatch` - Token user_id doesn't match request

#### Session
- `session_not_found` - Session doesn't exist
- `session_terminated` - Session was terminated
- `session_full` - Max participants reached

#### Participant
- `participant_not_found` - Participant doesn't exist
- `already_admitted` - User already in session
- `not_admitted` - Participant not in session

#### Authority
- `insufficient_permissions` - User lacks required permission
- `authority_write_failed` - Redis write failed after retries

#### Validation
- `invalid_parameter` - Parameter validation failed
- `invalid_operation` - Operation not allowed in current state

#### System
- `internal_error` - Unexpected server error
- `service_unavailable` - System degraded (e.g., Redis down)

---

## Status Code Summary

| Code | When Used | Client Action |
|------|-----------|---------------|
| 200 OK | Success (read/update) | Process response |
| 201 Created | Resource created | Process response |
| 204 No Content | Success (no body) | Consider complete |
| 400 Bad Request | Invalid input | Fix request, do NOT retry |
| 401 Unauthorized | Auth failed | Re-authenticate |
| 403 Forbidden | Not allowed | Do NOT retry |
| 404 Not Found | Resource missing | Handle appropriately |
| 409 Conflict | State conflict | Handle conflict |
| 500 Internal Server Error | Transient failure | Retry with backoff |
| 503 Service Unavailable | System degraded | Retry with backoff |

---

## Retry Guidelines

### Retryable Status Codes
- 500 Internal Server Error
- 503 Service Unavailable
- 504 Gateway Timeout (if added)

### Retry Strategy
```
Attempt 1: Immediate
Attempt 2: 1s delay
Attempt 3: 2s delay
Attempt 4: 4s delay
Attempt 5: 8s delay
Max attempts: 5
```

### Non-Retryable Status Codes
- 400, 401, 403, 404, 409 → Client must handle or give up

---

## Rate Limiting (V2)

V1: No rate limiting (internal users trusted)

V2 Plan:
- 10 requests/second per user
- 429 Too Many Requests response
- `Retry-After` header with seconds

---

## API Change Log

### v1.0.0 (2024-02-09)
- Initial API release
- Session management
- Admission & join
- Authority mutations
- WebSocket signaling

---

**End of API Wire Contracts**
