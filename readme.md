# Minimal 1-to-1 WebRTC baseline

This folder contains a minimal signaling + browser client setup for 1-to-1 WebRTC:

- `server.js`: HTTP + WebSocket signaling server (`ws`) with room management.
- `signaling.js`: WebSocket client helper.
- `transport.js`: WebRTC transport logic in browser.
- `index.html`: No-framework UI for joining a room and starting media.

## Message format

All signaling packets use this shape:

```json
{
  "type": "offer|answer|ice-candidate|join|...",
  "roomId": "room-123",
  "payload": {}
}
```

Server relays `offer`, `answer`, and `ice-candidate` without inspecting SDP.

## Local run

1. Install deps (includes `ws`):

```bash
npm install
```

2. Start signaling server:

```bash
node webrtc-baseline/server.js
```

3. Open two browser tabs/devices at:

- `http://<host-ip>:8080`

Both clients join the same room (default `room-123`).

## ngrok / reverse proxy

Expose port 8080 with ngrok:

```bash
ngrok http 8080
```

- Use ngrok `https://...` URL for page access.
- Set signaling URL to `wss://<your-ngrok-domain>/ws`.

Because server binds to `0.0.0.0` and uses HTTP upgrade handling, it works behind ngrok/reverse proxies.

## TURN integration notes

`transport.js` already has STUN configuration. To add TURN fallback, extend `rtcConfig.iceServers` with your TURN entries:

```js
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:turn.example.com:3478",
      username: "user",
      credential: "pass",
    },
  ],
};
```

Use short-lived TURN credentials in production.
