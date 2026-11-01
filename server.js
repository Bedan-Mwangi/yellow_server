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

let waitingQueue = [];
let pendingTokens = {};
let activeRooms = {};

// ---------- MATCH ----------
app.post('/match', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  const now = Date.now();
  waitingQueue = waitingQueue.filter(u => now - u.timestamp < 60000);

  const waiting = waitingQueue.find(u => u.userId !== userId);

  if (!waiting) {
    waitingQueue.push({ userId, timestamp: now });
    return res.json({ status: 'waiting' });
  }

  const roomId = `room_${waiting.userId}_${userId}_${now}`;

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
    waitingQueue.push({ userId, timestamp: now });
    return res.json({ status: 'waiting' });
  }

  waitingQueue = waitingQueue.filter(u => u.userId !== waiting.userId);

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

  activeRooms[roomId] = { userA: waiting.userId, userB: userId, createdAt: now };

  pendingTokens[waiting.userId] = {
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenB.toJwt(),
    matchedWith: userId
  };

  res.json({
    status: 'matched',
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenA.toJwt(),
    matchedWith: waiting.userId
  });
});

// ---------- POLL ----------
app.get('/match-status/:userId', (req, res) => {
  const { userId } = req.params;
  const pending = pendingTokens[userId];

  if (pending) {
    delete pendingTokens[userId];
    return res.json({
      status: 'matched',
      roomId: pending.roomId,
      livekitUrl: pending.livekitUrl,
      token: pending.token,
      matchedWith: pending.matchedWith
    });
  }

  if (waitingQueue.find(u => u.userId === userId)) {
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

app.get('/', (req, res) => res.send('Yellow server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Yellow server on port ${PORT}`));
