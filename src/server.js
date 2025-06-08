const express = require('express');
const multer = require('multer');
const MTProto = require('@mtproto/core');
const { Redis } = require('@upstash/redis');
const path = require('path');
const cors = require('cors');

const app = express();

// Configure in-memory file storage for Render's ephemeral filesystem
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Multiple Redis database credentials (for rotation)
const redisConfigs = [
  {
    url: process.env.UPSTASH_REDIS_REST_URL_1,
    token: process.env.UPSTASH_REDIS_REST_TOKEN_1,
  }
  // Add more databases as needed
];

// Initialize Redis clients
const redisClients = redisConfigs.map(config => new Redis({
  url: config.url,
  token: config.token,
}));

// Simple rotation logic based on usage or index
let currentRedisIndex = 0;
function getCurrentRedisClient() {
  return redisClients[currentRedisIndex];
}

// Rotate Redis client (e.g., based on usage or schedule)
async function rotateRedisClient() {
  const currentClient = getCurrentRedisClient();
  const stats = await currentClient.info('stats'); // Check usage
  const commandsUsed = parseInt(stats.total_commands_processed || '0', 10);
  if (commandsUsed > 450000) { // Rotate if nearing free tier limit (500K/month)
    currentRedisIndex = (currentRedisIndex + 1) % redisClients.length;
    console.log(`Rotated to Redis database ${currentRedisIndex + 1}`);
  }
}

// Telegram API client with custom Redis storage
class RedisStorage {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async set(key, value) {
    await this.redis.set(`session:${key}`, value);
  }

  async get(key) {
    return await this.redis.get(`session:${key}`);
  }
}

let telegramClient = null;

try {
  telegramClient = new MTProto({
    api_id: process.env.API_ID,
    api_hash: process.env.API_HASH,
    test: false,
    storageOptions: {
      instance: RedisStorage,
      options: getCurrentRedisClient(), // Pass current Redis client
    },
  });
  console.log('MTProto initialized successfully');
} catch (err) {
  console.error('Failed to initialize MTProto:', err);
  throw err;
}

// Login with .session file
app.post('/api/login', upload.single('session'), async (req, res) => {
  try {
    if (!req.file || !req.file.originalname.endsWith('.session')) {
      return res.status(400).json({ success: false, message: 'Invalid .session file' });
    }

    // Parse session data (assuming stringified JSON or raw string)
    const sessionData = req.file.buffer.toString();
    const redisClient = getCurrentRedisClient();

    // Store session in Redis
    const sessionId = `user:${Date.now()}`; // Unique session ID
    await redisClient.set(`session:${sessionId}`, sessionData);

    // Load session into MTProto
    try {
      telegramClient.storage.set('session', sessionData);
      const user = await telegramClient.call('users.getFullUser', {
        id: { _: 'inputUserSelf' },
      });
      console.log('Authenticated user:', user);
    } catch (err) {
      console.error('Session authentication failed:', err);
      return res.status(401).json({ success: false, message: 'Invalid session file' });
    }

    // Rotate Redis client if needed
    await rotateRedisClient();

    // Fetch example stats (replace with real Telegram API calls)
    const stats = {
      messages: 100,
      groups: 5,
    };

    res.json({ success: true, stats, sessionId });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Send bulk messages
app.post('/api/send-bulk-message', async (req, res) => {
  if (!telegramClient) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }

  const { message, recipients } = req.body;
  if (!message || !recipients || !Array.isArray(recipients)) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  try {
    let sentCount = 0;
    for (const recipient of recipients) {
      await new Promise(resolve => setTimeout(resolve, 50)); // Rate limit
      await telegramClient.call('messages.sendMessage', {
        peer: { _: 'inputPeerUser', user_id: parseInt(recipient) },
        message,
        random_id: Math.floor(Math.random() * 1000000),
      });
      sentCount++;
    }
    await rotateRedisClient(); // Check rotation after bulk operation
    res.json({ success: true, sentCount });
  } catch (err) {
    console.error('Bulk message error:', err);
    res.status(500).json({ success: false, message: 'Failed to send messages' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Start server
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`Server running on port ${port}`));
