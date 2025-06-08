const express = require('express');
const multer = require('multer');
const { MTProto } = require('@mtproto/core');
const path = require('path');
const cors = require('cors');

const app = express();

// Configure in-memory file storage for Render's ephemeral filesystem
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors()); // Allow frontend requests
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public'))); // Serve frontend

// Telegram API client
const mtproto = new MTProto({
  api_id: process.env.API_ID, // Set in Render environment variables
  api_hash: process.env.API_HASH,
});

// Store authenticated session (in-memory for Render free tier)
let telegramClient = null;

// Login with .session file
app.post('/api/login', upload.single('session'), async (req, res) => {
  try {
    if (!req.file || !req.file.originalname.endsWith('.session')) {
      return res.status(400).json({ success: false, message: 'Invalid .session file' });
    }

    // Parse session data (assumes .session file is compatible with MTProto)
    const sessionData = req.file.buffer.toString(); // Adjust based on your .session format
    telegramClient = new MTProto({
      api_id: process.env.API_ID,
      api_hash: process.env.API_HASH,
      session: sessionData, // Custom parsing may be needed
    });

    // Verify session (example: check if authenticated)
    try {
      await telegramClient.call('users.getFullUser', { id: { _: 'inputUserSelf' } });
    } catch (err) {
      return res.status(401).json({ success: false, message: 'Invalid session file' });
    }

    // Fetch example stats (replace with real Telegram API calls)
    const stats = {
      messages: 100, // Example: Fetch from messages.getHistory
      groups: 5,     // Example: Fetch from channels.getChannels
    };

    res.json({ success: true, stats });
  } catch (err) {
    console.error(err);
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
      // Rate limiting to comply with Telegram API (e.g., 20 messages/sec)
      await new Promise(resolve => setTimeout(resolve, 50));
      await telegramClient.call('messages.sendMessage', {
        peer: { _: 'inputPeerUser', user_id: parseInt(recipient) },
        message,
        random_id: Math.floor(Math.random() * 1000000),
      });
      sentCount++;
    }
    res.json({ success: true, sentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Failed to send messages' });
  }
});

// Health check for Render
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
