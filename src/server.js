const express = require('express');
const multer = require('multer');
const MTProto = require('@mtproto/core');
const { Redis } = require('@upstash/redis');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cors = require('cors');

const app = express();

// Configure in-memory file storage for Render's ephemeral filesystem
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Multiple Redis database credentials for rotation
const redisConfigs = [
  {
    url: process.env.UPSTASH_REDIS_REST_URL_1,
    token: process.env.UPSTASH_REDIS_REST_TOKEN_1,
  }
  // Add more databases as needed
];

// Initialize Redis clients
const redisClients = redisConfigs.map(config => {
  if (!config.url || !config.token) {
    console.error('Missing Redis credentials for config:', config);
    return null;
  }
  return new Redis({ url: config.url, token: config.token });
}).filter(client => client !== null);

// Rotation logic
let currentRedisIndex = 0;
function getCurrentRedisClient() {
  if (redisClients.length === 0) throw new Error('No valid Redis clients configured');
  return redisClients[currentRedisIndex];
}

async function rotateRedisClient() {
  try {
    const currentClient = getCurrentRedisClient();
    const stats = await currentClient.info('stats');
    const commandsUsed = parseInt(stats.total_commands_processed || '0', 10);
    if (commandsUsed > 450000) { // Rotate near free tier limit (500K/month)
      currentRedisIndex = (currentRedisIndex + 1) % redisClients.length;
      console.log(`Rotated to Redis database ${currentRedisIndex + 1}`);
    }
  } catch (err) {
    console.error('Error checking Redis stats for rotation:', err);
  }
}

// Custom Redis storage for MTProto
class RedisStorage {
  constructor(redisClient) {
    this.redis = redisClient;
  }

  async set(key, value) {
    await this.redis.set(`mtproto:${key}`, value);
  }

  async get(key) {
    return await this.redis.get(`mtproto:${key}`);
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
      options: getCurrentRedisClient(),
    },
  });
  console.log('MTProto initialized successfully');
} catch (err) {
  console.error('Failed to initialize MTProto:', err);
  throw err;
}

// Parse Telethon .session file
async function parseTelethonSession(buffer) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', (err) => {
      if (err) return reject(err);
    });

    db.serialize(() => {
      db.run('CREATE TABLE sessions (dc_id INTEGER, server_address TEXT, port INTEGER, auth_key BLOB, takeout_id INTEGER)', (err) => {
        if (err) return reject(err);
      });

      // Load buffer into SQLite
      db.loadExtension('sqlite3', buffer, (err) => {
        if (err) return reject(err);

        db.get('SELECT dc_id, server_address, auth_key FROM sessions LIMIT 1', (err, row) => {
          if (err) return reject(err);
          if (!row) return reject(new Error('No session data found in .session file'));

          resolve({
            dc_id: row.dc_id,
            server_address: row.server_address,
            auth_key: row.auth_key.toString('hex'), // Convert buffer to hex string
          });
        });
      });
    });
  });
}

// Login with .session file
app.post('/api/login', upload.single('session'), async (req, res) => {
  try {
    if (!req.file || !req.file.originalname.endsWith('.session')) {
      return res.status(400).json({ success: false, message: 'Invalid .session file' });
    }

    const redisClient = getCurrentRedisClient();
    const sessionId = `user:${Date.now()}`;

    // Parse Telethon .session file
    let sessionData;
    try {
      sessionData = await parseTelethonSession(req.file.buffer);
    } catch (err) {
      console.error('Failed to parse .session file:', err);
      return res.status(400).json({ success: false, message: 'Invalid .session file format' });
    }

    // Store session data in Redis
    await redisClient.set(`session:${sessionId}`, JSON.stringify(sessionData));

    // Load session into MTProto
    try {
      await telegramClient.storage.set('session', JSON.stringify(sessionData));
      const user = await telegramClient.call('users.getFullUser', {
        id: { _: 'inputUserSelf' },
      });
      console.log('Authenticated user:', user);
    } catch (err) {
      console.error('Session authentication failed:', err);
      return res.status(401).json({ success: false, message: 'Invalid session data' });
    }

    // Rotate Redis client if needed
    await rotateRedisClient();

    // Fetch example stats (replace with real Telegram API calls)
    const stats = {
      messages: 100, // Example: await telegramClient.call('messages.getHistory', ...)
      groups: 5,     // Example: await telegramClient.call('channels.getChannels', ...)
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

  const { message, recipients, sessionId } = req.body;
  if (!message || !recipients || !Array.isArray(recipients) || !sessionId) {
    return res.status(400).json({ success: false, message: 'Invalid input' });
  }

  const redisClient = getCurrentRedisClient();
  const sessionData = await redisClient.get(`session:${sessionId}`);
  if (!sessionData) {
    return res.status(401).json({ success: false, message: 'Session expired or invalid' });
  }

  try {
    await telegramClient.storage.set('session', sessionData); // Reload session
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
    await rotateRedisClient();
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
