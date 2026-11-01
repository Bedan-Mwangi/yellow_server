require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// In-memory queue. For MVP only. Restart = queue clears. Fine for launch.
let waitingQueue = []; // { userId, socketId, timestamp }
let activeRooms = {};  // roomId -> { userA, userB, createdAt }

// ---------- MATCH ----------
app.post('/match', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  // Remove stale entries older than 60 seconds
  const now = Date.now();
  waitingQueue = waitingQueue.filter(u => now - u.timestamp < 60000);

  // Check if someone is already waiting
  const waiting = waitingQueue.find(u => u.userId !== userId);

  if (!waiting) {
    // No one waiting — join queue
    waitingQueue.push({ userId, timestamp: now });
    return res.json({ status: 'waiting' });
  }

  // Someone is waiting — create a room and match them
  const roomId = `room_${waiting.userId}_${userId}_${now}`;

  // Check block list: if either blocked the other, skip
  const { data: blocks } = await supabase
    .from('blocks')
    .select('*')
    .or(`blocker_id.eq.${waiting.userId},blocker_id.eq.${userId}`);

  const isBlocked = blocks?.some(
    b =>
      (b.blocker_id === waiting.userId && b.blocked_id === userId) ||
      (b.blocker_id === userId && b.blocked_id === waiting.userId)
  );

  if (isBlocked) {
    // Put current user back in queue, skip this match
    waitingQueue.push({ userId, timestamp: now });
    return res.json({ status: 'waiting' });
  }

  // Remove the waiting user from queue
  waitingQueue = waitingQueue.filter(u => u.userId !== waiting.userId);

  // Create LiveKit tokens for both
  const tokenA = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: waiting.userId, ttl: '15m' }
  );
  tokenA.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true });

  const tokenB = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    { identity: userId, ttl: '15m' }
  );
  tokenB.addGrant({ roomJoin: true, room: roomId, canPublish: true, canSubscribe: true });

  // Track active room
  activeRooms[roomId] = { userA: waiting.userId, userB: userId, createdAt: now };

  res.json({
    status: 'matched',
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenA.toJwt(), // token for the CALLER (the one who got matched)
    // We'll send the other token via a polling endpoint below
  });

  // Store the other token temporarily for pickup
  pendingTokens[waiting.userId] = {
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenB.toJwt(),
    matchedWith: userId
  };
});

// ---------- POLL FOR MATCH (for the waiting user) ----------
const pendingTokens = {};

app.get('/match-status/:userId', (req, res) => {
  const { userId } = req.params;
  const pending = pendingTokens[userId];

  if (pending) {
    delete pendingTokens[userId];
    return res.json({
      status: 'matched',
      roomId: pending.roomId,
      livekitUrl: pending.livekitUrl,
      token: pending.token
    });
  }

  // Check if still in queue
  const stillWaiting = waitingQueue.find(u => u.userId === userId);
  if (stillWaiting) {
    return res.json({ status: 'waiting' });
  }

  return res.json({ status: 'idle' });
});

// ---------- CANCEL ----------
app.post('/cancel', (req, res) => {
  const { userId } = req.body;
  waitingQueue = waitingQueue.filter(u => u.userId !== userId);
  delete pendingTokens[userId];
  res.json({ status: 'cancelled' });
});

// ---------- REPORT ----------
app.post('/report', async (req, res) => {
  const { reporterId, reportedId, roomId } = req.body;

  await supabase.from('reports').insert({
    reporter_id: reporterId,
    reported_id: reportedId,
    room_id: roomId
  });

  // Auto-block on report
  await supabase.from('blocks').insert({
    blocker_id: reporterId,
    blocked_id: reportedId
  });

  res.json({ status: 'reported' });
});

// ---------- BLOCK ----------
app.post('/block', async (req, res) => {
  const { blockerId, blockedId } = req.body;

  await supabase.from('blocks').insert({
    blocker_id: blockerId,
    blocked_id: blockedId
  });

  res.json({ status: 'blocked' });
});

// ---------- HEALTH ----------
app.get('/', (req, res) => res.send('Yellow server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Yellow server on port ${PORT}`));