const express = require('express');
const multer = require('multer');
const MTProto = require('@mtproto/core'); // Ensure correct import
const path = require('path');
const cors = require('cors');

const app = express();

// Configure in-memory file storage for Render's ephemeral filesystem
const upload = multer({ storage: multer.memoryStorage() });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Telegram API client
let telegramClient = null;

try {
  telegramClient = new MTProto({
    api_id: process.env.API_ID,
    api_hash: process.env.API_HASH,
    test: false, // Use production Telegram servers
  });
  console.log('MTProto initialized successfully');
} catch (err) {
  console.error('Failed to initialize MTProto:', err);
}

// Login with .session file
app.post('/api/login', upload.single('session'), async (req, res) => {
  try {
    if (!req.file || !req.file.originalname.endsWith('.session')) {
      return res.status(400).json({ success: false, message: 'Invalid .session file' });
    }

    // Parse session data (custom parsing may be needed)
    const sessionData = req.file.buffer.toString();
    if (!telegramClient) {
      return res.status(500).json({ success: false, message: 'Telegram client not initialized' });
    }

    // Attempt to set session (this is pseudo-code; adjust based on actual .session format)
    try {
      telegramClient.storage.set('session', sessionData); // Example; may need custom logic
      await telegramClient.call('users.getFullUser', { id: { _: 'inputUserSelf' } });
    } catch (err) {
      console.error('Session authentication failed:', err);
      return res.status(401).json({ success: false, message: 'Invalid session file' });
    }

    // Fetch example stats (replace with real Telegram API calls)
    const stats = {
      messages: 100,
      groups: 5,
    };

    res.json({ success: true, stats });
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
    res.json({ success: true, sentCount });
  } catch (err) {
    console.error('Bulk message error:', err);
    res.status(500).json({ success: false, message: 'Failed to send messages' });
  }
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
