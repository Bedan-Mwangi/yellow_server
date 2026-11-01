require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
app.use(cors());
app.use(express.json());

let waitingQueue = [];
let pendingTokens = {};

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

  pendingTokens[waiting.userId] = {
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenB.toJwt()
  };

  res.json({
    status: 'matched',
    roomId,
    livekitUrl: process.env.LIVEKIT_URL,
    token: tokenA.toJwt()
  });
});

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

  if (waitingQueue.find(u => u.userId === userId)) {
    return res.json({ status: 'waiting' });
  }

  return res.json({ status: 'idle' });
});

app.post('/cancel', (req, res) => {
  const { userId } = req.body;
  waitingQueue = waitingQueue.filter(u => u.userId !== userId);
  delete pendingTokens[userId];
  res.json({ status: 'cancelled' });
});

app.get('/', (req, res) => res.send('Yellow server running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Yellow server on port ${PORT}`));
