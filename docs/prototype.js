// prototype/server.js - Session Manager stub
const express = require('express');
const redis = require('redis');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

const redisClient = redis.createClient({ url: 'redis://localhost:6379' });
redisClient.connect();

const SECRET = 'dev-secret-change-in-prod';

// Middleware: Verify user JWT
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  
  try {
    const token = auth.slice(7);
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
  }
}

// Helper: Write authority with retry-until-visible
async function writeAuthority(key, field, value, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await redisClient.hSet(key, field, value);
    const readback = await redisClient.hGet(key, field);
    if (readback === value) {
      return { success: true };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Authority write failed: not visible after retries');
}

// API: Create Session
app.post('/v1/sessions', authMiddleware, async (req, res) => {
  const sessionId = `sess_${Date.now()}`;
  const sessionMeta = {
    created_at: Date.now(),
    created_by: req.userId,
    status: 'active',
    max_participants: req.body.max_participants || 10
  };

  try {
    // Write to Redis (authority namespace)
    await writeAuthority(
      `auth:sess:${sessionId}:meta`,
      'data',
      JSON.stringify(sessionMeta)
    );

    res.status(201).json({
      session_id: sessionId,
      ...sessionMeta
    });
  } catch (err) {
    console.error('Session creation failed:', err);
    res.status(500).json({
      error: 'authority_write_failed',
      message: err.message,
      retry_after: 5
    });
  }
});

// API: Request Join
app.post('/v1/sessions/:sessionId/join', authMiddleware, async (req, res) => {
  const { sessionId } = req.params;
  
  // Check session exists
  const sessionData = await redisClient.hGet(`auth:sess:${sessionId}:meta`, 'data');
  if (!sessionData) {
    return res.status(404).json({ error: 'session_not_found' });
  }

  const participantId = `part_${Date.now()}`;
  const participantData = {
    user_id: req.userId,
    role: 'participant',
    permissions: {
      can_send_audio: true,
      can_send_video: true,
      can_receive_media: true,
      can_send_chat: true
    },
    admitted_at: Date.now()
  };

  try {
    // Write participant to authority namespace
    await writeAuthority(
      `auth:sess:${sessionId}:participants`,
      participantId,
      JSON.stringify(participantData)
    );

    // Issue session token
    const sessionToken = jwt.sign({
      sub: participantId,
      session_id: sessionId,
      user_id: req.userId,
      role: participantData.role,
      permissions: participantData.permissions,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400  // 24h
    }, SECRET);

    res.status(200).json({
      status: 'admitted',
      participant_id: participantId,
      token: sessionToken,
      token_expires_at: Math.floor(Date.now() / 1000) + 86400
    });
  } catch (err) {
    console.error('Admission failed:', err);
    res.status(500).json({
      error: 'authority_write_failed',
      message: err.message
    });
  }
});

// API: Revoke Permission
app.post('/v1/sessions/:sessionId/participants/:participantId/revoke',
  authMiddleware,
  async (req, res) => {
    const { sessionId, participantId } = req.params;
    const { permissions: permissionsToRevoke } = req.body;

    // Fetch current participant data
    const participantJson = await redisClient.hGet(
      `auth:sess:${sessionId}:participants`,
      participantId
    );
    
    if (!participantJson) {
      return res.status(404).json({ error: 'participant_not_found' });
    }

    const participantData = JSON.parse(participantJson);
    
    // Revoke permissions
    permissionsToRevoke.forEach(perm => {
      participantData.permissions[perm] = false;
    });

    try {
      // Write updated permissions (retry-until-visible)
      await writeAuthority(
        `auth:sess:${sessionId}:participants`,
        participantId,
        JSON.stringify(participantData)
      );

      res.status(200).json({
        participant_id: participantId,
        permissions: participantData.permissions,
        updated_at: Date.now()
      });
    } catch (err) {
      console.error('Revoke failed:', err);
      res.status(500).json({
        error: 'authority_write_failed',
        message: err.message
      });
    }
  }
);

// Start server
app.listen(3000, () => {
  console.log('Session Manager running on port 3000');
  console.log('Redis connection: OK');
});
