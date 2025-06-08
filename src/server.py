from telethon import TelegramClient
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import uvicorn
import os
import redis.asyncio as redis
import json
import asyncio
import logging
from typing import List, Dict, Any

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# Enable CORS for frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files (frontend)
app.mount("/public", StaticFiles(directory="public"), name="public")

# Redis configurations for rotation
redis_configs = [
    {
        "url": os.getenv('UPSTASH_REDIS_REST_URL_1'),
        "token": os.getenv('UPSTASH_REDIS_REST_TOKEN_1'),
    }
    # Add more databases as needed
]

# Initialize Redis connection pools
redis_pools = [
    redis.ConnectionPool.from_url(config["url"], password=config["token"])
    for config in redis_configs
    if config["url"] and config["token"]
]

if not redis_pools:
    raise RuntimeError("No valid Redis configurations provided")

# Rotation logic
current_redis_index = 0

async def get_current_redis_pool():
    if not redis_pools:
        raise RuntimeError("No valid Redis pools available")
    return redis_pools[current_redis_index]

async def rotate_redis_pool():
    global current_redis_index
    try:
        pool = await get_current_redis_pool()
        async with redis.Redis.from_pool(pool) as r:
            stats = await r.info("stats")
            commands_used = int(stats.get("total_commands_processed", 0))
            if commands_used > 450000:  # Rotate near free tier limit (500K/month)
                current_redis_index = (current_redis_index + 1) % len(redis_pools)
                logger.info(f"Rotated to Redis database {current_redis_index + 1}")
    except Exception as e:
        logger.error(f"Error checking Redis stats for rotation: {e}")

@app.post("/api/login")
async def login(file: UploadFile = File(...)):
    if not file.filename.endswith('.session'):
        raise HTTPException(status_code=400, detail="Invalid .session file")

    session_id = f"user:{os.urandom(8).hex()}"
    session_path = f"/tmp/{session_id}.session"

    try:
        # Write uploaded file to temporary path
        content = await file.read()
        with open(session_path, 'wb') as f:
            f.write(content)

        # Authenticate with Telethon
        client = TelegramClient(
            session_path,
            int(os.getenv('API_ID')),
            os.getenv('API_HASH')
        )
        await client.connect()
        if not await client.is_user_authorized():
            os.remove(session_path)
            raise HTTPException(status_code=401, detail="Invalid session")

        # Extract session data
        session_data = {
            "dc_id": client.session.dc_id,
            "server_address": client.session.server_address,
            "port": client.session.port,
            "auth_key": client.session.auth_key.hex(),
            "takeout_id": client.session.takeout_id
        }

        # Store session data in Redis
        pool = await get_current_redis_pool()
        async with redis.Redis.from_pool(pool) as r:
            await r.set(f"session:{session_id}", json.dumps(session_data), ex=86400)  # Expire in 24 hours

        # Fetch example stats (replace with real Telegram API calls)
        stats = {
            "messages": 100,  # Example: await client.get_messages(...)
            "groups": 5,      # Example: await client.get_dialogs(...)
        }

        await client.disconnect()
        os.remove(session_path)
        await rotate_redis_pool()

        return {"success": True, "stats": stats, "sessionId": session_id}
    except Exception as e:
        if os.path.exists(session_path):
            os.remove(session_path)
        logger.error(f"Login error: {e}")
        raise HTTPException(status_code=500, detail=f"Server error: {str(e)}")

@app.post("/api/send-bulk-message")
async def send_bulk_message(data: Dict[str, Any]):
    session_id = data.get('sessionId')
    message = data.get('message')
    recipients = data.get('recipients', [])

    if not session_id or not message or not isinstance(recipients, list):
        raise HTTPException(status_code=400, detail="Invalid input")

    pool = await get_current_redis_pool()
    async with redis.Redis.from_pool(pool) as r:
        session_data = await r.get(f"session:{session_id}")
        if not session_data:
            raise HTTPException(status_code=401, detail="Session expired or invalid")
        session_data = json.loads(session_data)

    session_path = f"/tmp/{session_id}.session"
    client = TelegramClient(
        session_path,
        int(os.getenv('API_ID')),
        os.getenv('API_HASH')
    )

    try:
        await client.connect()
        client.session.set_dc(
            session_data['dc_id'],
            session_data['server_address'],
            session_data['port']
        )
        client.session.auth_key = bytes.fromhex(session_data['auth_key'])

        sent_count = 0
        for recipient in recipients:
            try:
                await client.send_message(int(recipient), message)
                sent_count += 1
                await asyncio.sleep(0.05)  # Rate limit
            except Exception as e:
                logger.warning(f"Failed to send message to {recipient}: {e}")
        await client.disconnect()
        os.remove(session_path)
        await rotate_redis_pool()
        return {"success": True, "sentCount": sent_count}
    except Exception as e:
        await client.disconnect()
        if os.path.exists(session_path):
            os.remove(session_path)
        logger.error(f"Bulk message error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send messages: {str(e)}")

@app.get("/health")
async def health():
    return {"status": "ok"}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv('PORT', 10000)))
