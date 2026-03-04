from __future__ import annotations

import asyncio
import hashlib
import hmac
import importlib
import json
import os
import re
import secrets
import smtplib
import subprocess
import time
import uuid
from collections import defaultdict
from contextlib import suppress
from urllib import parse, request
from base64 import b64encode, urlsafe_b64decode, urlsafe_b64encode
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path
from typing import Any, cast

from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import desc, select, text, func
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session, joinedload

try:
    import numpy as np
except Exception:
    np = None

try:
    import faiss  # type: ignore
except Exception:
    faiss = None

try:
    boto3 = importlib.import_module("boto3")
except Exception:
    boto3 = None

try:
    BotoConfig = getattr(importlib.import_module("botocore.client"), "Config")
except Exception:
    BotoConfig = None

try:
    redis = importlib.import_module("redis")
except Exception:
    redis = None

from .database import Base, engine, get_db
from .models import (
    AccountDeletionOTP,
    AuthToken,
    ChatDeviceSession,
    ChatEmailOTP,
    ChatMessage,
    ChatTypingState,
    Comment,
    CommentReaction,
    Notification,
    PasswordResetAttempt,
    PasswordResetOTP,
    Post,
    PostImage,
    PostLike,
    ProfileView,
    RegistrationEmailOTP,
    SecurityActionOTP,
    Story,
    StoryView,
    User,
    UserBlock,
    UserFeedState,
    UserFollow,
    UserPrivacySetting,
    UserProfilePhoto,
    UserVisibilityRule,
)
from .schemas import (
    AuthOut,
    ChatAuthOut,
    ChatAuthStatusOut,
    ChatConversationOut,
    ChatMessageOut,
    ChatThreadOut,
    CommentCreate,
    CommentReactionDetailOut,
    CommentReactionUserOut,
    CommentOut,
    FeedOut,
    LoginIn,
    NotificationActorOut,
    NotificationOut,
    PostOut,
    ProfileOut,
    StoryBarUserOut,
    StoryOut,
    UserOut,
)

MENTION_PATTERN = re.compile(r"@([a-zA-Z0-9_]{3,40})")
EMAIL_PATTERN = re.compile(r"^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,63}$", re.IGNORECASE)
DEFAULT_UPLOAD_DIR = Path("static/uploads")
FALLBACK_UPLOAD_DIR = Path("/tmp/stepnix-uploads")
UPLOAD_DIR = DEFAULT_UPLOAD_DIR
UPLOAD_PATH_PREFIX = "static/uploads"
try:
    DEFAULT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
except OSError:
    FALLBACK_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR = FALLBACK_UPLOAD_DIR
    UPLOAD_PATH_PREFIX = "uploads"
ALLOWED_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
ALLOWED_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm"}
ALLOWED_REACTIONS = {"like", "love", "celebrate"}
ALLOWED_GENDERS = {"male", "female", "prefer_not_to_say"}
OTP_EXPIRY_MINUTES = 10
OTP_COOLDOWN_SECONDS = 60
OTP_MAX_PER_10_MIN = 3
OTP_MAX_PER_DAY = 10
CHAT_OTP_EXPIRY_MINUTES = 5
APP_ENV = os.getenv("APP_ENV", "development").lower()
ENFORCE_OTP_LIMITS = os.getenv("ENFORCE_OTP_LIMITS", "0" if APP_ENV == "development" else "1") == "1"
FEED_RANKER_MODE = os.getenv("FEED_RANKER_MODE", "heuristic").strip().lower()
FEED_CACHE_TTL_SECONDS = max(5, int(os.getenv("FEED_CACHE_TTL_SECONDS", "20") or "20"))
try:
    _feed_dim_raw = int(os.getenv("FEED_EMBED_DIM", "256"))
except ValueError:
    _feed_dim_raw = 256
FEED_EMBED_DIM = max(64, min(1024, _feed_dim_raw))
REDIS_URL = (os.getenv("REDIS_URL") or "").strip()
S3_BUCKET_NAME = (os.getenv("S3_BUCKET_NAME") or "").strip()
AWS_ACCESS_KEY = (os.getenv("AWS_ACCESS_KEY") or "").strip()
AWS_SECRET_KEY = (os.getenv("AWS_SECRET_KEY") or "").strip()
AWS_REGION = (os.getenv("AWS_REGION") or "us-east-1").strip()
FAISS_INDEX_PATH = (os.getenv("FAISS_INDEX_PATH") or "").strip()
HELP_CENTER_EMAIL = "stepnix627@gmail.com"
HELP_CENTER_TOPICS = {
    "bug": "Reported a bug",
    "feedback": "Feedback",
    "question": "Asked a question",
    "idea": "Suggested an idea",
}

app = FastAPI(title="Goal Progress Blog API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
if UPLOAD_DIR != DEFAULT_UPLOAD_DIR:
    app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")


class NotificationHub:
    def __init__(self) -> None:
        self._connections: dict[int, set[WebSocket]] = defaultdict(set)
        self._loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[user_id].add(websocket)
        self._loop = asyncio.get_running_loop()

    async def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        sockets = self._connections.get(user_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self._connections.pop(user_id, None)

    async def _publish(self, user_id: int, payload: dict[str, Any]) -> None:
        sockets = list(self._connections.get(user_id) or ())
        if not sockets:
            return
        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(payload)
            except Exception:
                stale.append(socket)
        for socket in stale:
            await self.disconnect(user_id, socket)

    def publish(self, user_id: int, payload: dict[str, Any]) -> None:
        sockets = self._connections.get(user_id)
        if not sockets or not self._loop:
            return
        try:
            self._loop.call_soon_threadsafe(asyncio.create_task, self._publish(user_id, payload))
        except RuntimeError:
            return


notification_hub = NotificationHub()
_redis_client: Any | None = None
_s3_client: Any | None = None
_persisted_faiss_index: Any | None = None
_persisted_faiss_post_ids: list[int] = []


def _get_redis_client() -> Any | None:
    global _redis_client
    if _redis_client is not None:
        return _redis_client
    if redis is None or not REDIS_URL:
        return None
    try:
        _redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    except Exception:
        _redis_client = None
    return _redis_client


def _redis_get(key: str) -> str | None:
    client = _get_redis_client()
    if client is None:
        return None
    try:
        value = client.get(key)
    except Exception:
        return None
    return str(value) if value is not None else None


def _redis_setex(key: str, ttl: int, value: str) -> None:
    client = _get_redis_client()
    if client is None:
        return
    with suppress(Exception):
        client.setex(key, ttl, value)


def _redis_delete(*keys: str) -> None:
    client = _get_redis_client()
    if client is None or not keys:
        return
    with suppress(Exception):
        client.delete(*keys)


def _redis_incr(key: str) -> int:
    client = _get_redis_client()
    if client is None:
        return 0
    try:
        return int(client.incr(key))
    except Exception:
        return 0


def _redis_publish(channel: str, payload: dict[str, Any]) -> None:
    client = _get_redis_client()
    if client is None:
        return
    with suppress(Exception):
        client.publish(channel, json.dumps(payload, default=str))


def _feed_cache_version() -> int:
    raw = _redis_get("feed:version")
    if not raw:
        return 0
    try:
        return int(raw)
    except ValueError:
        return 0


def _bump_feed_cache_version() -> None:
    _redis_incr("feed:version")


def _feed_cache_key(user_id: int) -> str:
    return f"feed:{user_id}:v{_feed_cache_version()}"


def _notification_count_key(user_id: int) -> str:
    return f"notifications:unread:{user_id}"


def _invalidate_notification_counts(*user_ids: int) -> None:
    keys = [_notification_count_key(user_id) for user_id in user_ids if user_id]
    if keys:
        _redis_delete(*keys)


def _get_s3_client() -> Any | None:
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    if boto3 is None or BotoConfig is None or not S3_BUCKET_NAME:
        return None
    try:
        _s3_client = boto3.client(
            "s3",
            aws_access_key_id=AWS_ACCESS_KEY or None,
            aws_secret_access_key=AWS_SECRET_KEY or None,
            region_name=AWS_REGION,
            config=BotoConfig(signature_version="s3v4"),
        )
    except Exception:
        _s3_client = None
    return _s3_client


def _s3_public_url(key: str) -> str:
    return f"https://{S3_BUCKET_NAME}.s3.{AWS_REGION}.amazonaws.com/{key}"


def _upload_bytes_to_s3(data: bytes, filename: str, *, folder: str, content_type: str = "") -> str | None:
    client = _get_s3_client()
    if client is None:
        return None
    ext = Path(filename).suffix.lower()
    key = f"{folder.strip('/')}/{uuid.uuid4().hex}{ext}"
    extra_args: dict[str, Any] = {}
    if content_type:
        extra_args["ContentType"] = content_type
    try:
        client.put_object(Bucket=S3_BUCKET_NAME, Key=key, Body=data, **extra_args)
    except Exception:
        return None
    return _s3_public_url(key)


def _upload_local_file_to_s3(local_path: Path, *, folder: str) -> str | None:
    client = _get_s3_client()
    if client is None or not local_path.exists():
        return None
    key = f"{folder.strip('/')}/{uuid.uuid4().hex}{local_path.suffix.lower()}"
    extra_args: dict[str, Any] = {}
    suffix = local_path.suffix.lower()
    if suffix in ALLOWED_VIDEO_EXT:
        extra_args["ContentType"] = "video/mp4" if suffix == ".mp4" else "application/octet-stream"
    elif suffix in ALLOWED_IMAGE_EXT:
        extra_args["ContentType"] = "image/jpeg" if suffix in {".jpg", ".jpeg"} else "application/octet-stream"
    try:
        if extra_args:
            client.upload_file(str(local_path), S3_BUCKET_NAME, key, ExtraArgs=extra_args)
        else:
            client.upload_file(str(local_path), S3_BUCKET_NAME, key)
    except Exception:
        return None
    return _s3_public_url(key)


def _persist_local_media_path(path_value: str, *, folder: str) -> str:
    if path_value.startswith("http://") or path_value.startswith("https://"):
        return path_value
    abs_path = _resolve_local_media_path(path_value)
    remote_url = _upload_local_file_to_s3(abs_path, folder=folder)
    if remote_url:
        with suppress(OSError):
            abs_path.unlink()
        return remote_url
    return path_value


def _resolve_local_media_path(path_value: str) -> Path:
    raw = str(path_value).lstrip("/")
    if raw.startswith(f"{UPLOAD_PATH_PREFIX}/"):
        filename = raw[len(UPLOAD_PATH_PREFIX) + 1 :]
        return UPLOAD_DIR / filename
    path = Path(raw)
    if path.is_absolute():
        return path
    return Path.cwd() / raw


def _load_persisted_faiss_index() -> None:
    global _persisted_faiss_index, _persisted_faiss_post_ids
    _persisted_faiss_index = None
    _persisted_faiss_post_ids = []
    if not FAISS_INDEX_PATH or faiss is None:
        return
    index_path = Path(FAISS_INDEX_PATH)
    metadata_path = index_path.with_suffix(f"{index_path.suffix}.meta.json")
    if not index_path.exists() or not metadata_path.exists():
        return
    try:
        _persisted_faiss_index = cast(Any, faiss).read_index(str(index_path))
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        _persisted_faiss_post_ids = [int(item) for item in payload.get("post_ids", [])]
    except Exception:
        _persisted_faiss_index = None
        _persisted_faiss_post_ids = []

def _ensure_schema() -> None:
    with engine.begin() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) DEFAULT ''"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255) DEFAULT ''"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(24) DEFAULT ''"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS gender VARCHAR(20) DEFAULT 'prefer_not_to_say'"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER DEFAULT 0"))
        conn.execute(text("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_post_date TIMESTAMP WITHOUT TIME ZONE"))
        conn.execute(text("UPDATE users SET current_streak = 0 WHERE current_streak IS NULL"))
        conn.execute(text("UPDATE users SET gender = 'prefer_not_to_say' WHERE gender IS NULL OR gender = ''"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_users_gender ON users(gender)"))
        conn.execute(
            text(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS uq_users_mobile_number_nonempty
                ON users(mobile_number)
                WHERE mobile_number IS NOT NULL AND mobile_number <> ''
                """
            )
        )
        conn.execute(text("ALTER TABLE posts ADD COLUMN IF NOT EXISTS day_experience TEXT DEFAULT ''"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS auth_tokens (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    token VARCHAR(255) UNIQUE NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS password_reset_otps (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    otp_hash VARCHAR(255) NOT NULL,
                    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE password_reset_otps ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS password_reset_attempts (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
                    email VARCHAR(255) NOT NULL,
                    ip_address VARCHAR(64) NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS registration_email_otps (
                    id SERIAL PRIMARY KEY,
                    email VARCHAR(255) NOT NULL,
                    otp_hash VARCHAR(255) NOT NULL,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    is_used BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_registration_email_otps_email ON registration_email_otps(email)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_registration_email_otps_expires_at ON registration_email_otps(expires_at)")
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_registration_email_otps_is_used ON registration_email_otps(is_used)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS account_deletion_otps (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    email VARCHAR(255) NOT NULL,
                    otp_hash VARCHAR(255) NOT NULL,
                    stage VARCHAR(20) NOT NULL,
                    reason TEXT NOT NULL DEFAULT '',
                    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    is_used BOOLEAN NOT NULL DEFAULT FALSE,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_user_id ON account_deletion_otps(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_email ON account_deletion_otps(email)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_stage ON account_deletion_otps(stage)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_is_verified ON account_deletion_otps(is_verified)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_is_used ON account_deletion_otps(is_used)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_account_deletion_otps_expires_at ON account_deletion_otps(expires_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_follows (
                    id SERIAL PRIMARY KEY,
                    follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    following_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_user_follow_pair UNIQUE (follower_id, following_id)
                )
                """
            )
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS profile_views (
                    id SERIAL PRIMARY KEY,
                    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    viewed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_profile_views_viewer_id ON profile_views(viewer_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_profile_views_viewed_user_id ON profile_views(viewed_user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_profile_views_created_at ON profile_views(created_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_privacy_settings (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                    show_message_seen BOOLEAN NOT NULL DEFAULT TRUE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_privacy_settings_user_id ON user_privacy_settings(user_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_user_privacy_settings_show_message_seen ON user_privacy_settings(show_message_seen)")
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_visibility_rules (
                    id SERIAL PRIMARY KEY,
                    owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    rule_type VARCHAR(20) NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_visibility_rule_scope UNIQUE (owner_id, target_user_id, rule_type)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_visibility_rules_owner_id ON user_visibility_rules(owner_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_user_visibility_rules_target_user_id ON user_visibility_rules(target_user_id)")
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_visibility_rules_rule_type ON user_visibility_rules(rule_type)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_blocks (
                    id SERIAL PRIMARY KEY,
                    blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_user_block_pair UNIQUE (blocker_id, blocked_user_id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_blocks_blocker_id ON user_blocks(blocker_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_blocks_blocked_user_id ON user_blocks(blocked_user_id)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS security_action_otps (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    email VARCHAR(255) NOT NULL,
                    action VARCHAR(30) NOT NULL,
                    otp_hash VARCHAR(255) NOT NULL,
                    pending_value VARCHAR(255) NOT NULL DEFAULT '',
                    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
                    is_used BOOLEAN NOT NULL DEFAULT FALSE,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_user_id ON security_action_otps(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_email ON security_action_otps(email)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_action ON security_action_otps(action)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_is_verified ON security_action_otps(is_verified)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_is_used ON security_action_otps(is_used)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_security_action_otps_expires_at ON security_action_otps(expires_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS stories (
                    id SERIAL PRIMARY KEY,
                    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    media_path VARCHAR(255) NOT NULL,
                    media_type VARCHAR(16) NOT NULL DEFAULT 'image',
                    duration_seconds INTEGER NOT NULL DEFAULT 5,
                    caption TEXT NOT NULL DEFAULT '',
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE stories ADD COLUMN IF NOT EXISTS media_path VARCHAR(255)"))
        conn.execute(text("ALTER TABLE stories ADD COLUMN IF NOT EXISTS media_type VARCHAR(16) DEFAULT 'image'"))
        conn.execute(text("ALTER TABLE stories ADD COLUMN IF NOT EXISTS duration_seconds INTEGER DEFAULT 5"))
        conn.execute(text("ALTER TABLE stories ADD COLUMN IF NOT EXISTS sticker_data TEXT DEFAULT ''"))
        conn.execute(
            text(
                """
                DO $$
                BEGIN
                  IF EXISTS (
                    SELECT 1
                    FROM information_schema.columns
                    WHERE table_name='stories' AND column_name='image_path'
                  ) THEN
                    EXECUTE 'ALTER TABLE stories ALTER COLUMN image_path DROP NOT NULL';
                    EXECUTE 'ALTER TABLE stories ALTER COLUMN image_path SET DEFAULT ''''';
                    UPDATE stories
                    SET media_path = COALESCE(media_path, image_path)
                    WHERE media_path IS NULL;
                  END IF;
                END $$;
                """
            )
        )
        conn.execute(text("UPDATE stories SET media_path = '' WHERE media_path IS NULL"))
        conn.execute(text("ALTER TABLE stories ALTER COLUMN media_path SET DEFAULT ''"))
        conn.execute(text("ALTER TABLE stories ALTER COLUMN media_path SET NOT NULL"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stories_author_id ON stories(author_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_stories_created_at ON stories(created_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS story_views (
                    id SERIAL PRIMARY KEY,
                    story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
                    viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_story_view_story_viewer UNIQUE (story_id, viewer_id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_story_views_story_id ON story_views(story_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_story_views_viewer_id ON story_views(viewer_id)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS notifications (
                    id SERIAL PRIMARY KEY,
                    recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    event_type VARCHAR(40) NOT NULL,
                    title VARCHAR(180) NOT NULL,
                    message VARCHAR(350) NOT NULL DEFAULT '',
                    post_id INTEGER NULL REFERENCES posts(id) ON DELETE CASCADE,
                    comment_id INTEGER NULL REFERENCES comments(id) ON DELETE CASCADE,
                    is_read BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message VARCHAR(350) DEFAULT ''"))
        conn.execute(text("ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read BOOLEAN DEFAULT FALSE"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_recipient_id ON notifications(recipient_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_actor_id ON notifications(actor_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_created_at ON notifications(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_notifications_is_read ON notifications(is_read)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_email_otps (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    email VARCHAR(255) NOT NULL,
                    otp_hash VARCHAR(255) NOT NULL,
                    secret_code_hash VARCHAR(255) NOT NULL,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    is_used BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_email_otps_user_id ON chat_email_otps(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_email_otps_email ON chat_email_otps(email)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_email_otps_expires_at ON chat_email_otps(expires_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_mobile_otps (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    mobile_number VARCHAR(24) NOT NULL,
                    otp_hash VARCHAR(255) NOT NULL,
                    expires_at TIMESTAMP WITHOUT TIME ZONE NOT NULL,
                    is_used BOOLEAN NOT NULL DEFAULT FALSE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_mobile_otps_user_id ON chat_mobile_otps(user_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_mobile_otps_mobile_number ON chat_mobile_otps(mobile_number)")
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_mobile_otps_expires_at ON chat_mobile_otps(expires_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_device_sessions (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    device_id VARCHAR(120) NOT NULL,
                    session_token VARCHAR(255) NOT NULL UNIQUE,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    last_active_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_chat_device_user UNIQUE (user_id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_device_sessions_user_id ON chat_device_sessions(user_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_device_sessions_last_active_at ON chat_device_sessions(last_active_at)")
        )
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id SERIAL PRIMARY KEY,
                    sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    receiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    content TEXT NOT NULL,
                    created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    seen_at TIMESTAMP WITHOUT TIME ZONE,
                    deleted_for_sender BOOLEAN NOT NULL DEFAULT FALSE,
                    deleted_for_receiver BOOLEAN NOT NULL DEFAULT FALSE,
                    deleted_for_everyone BOOLEAN NOT NULL DEFAULT FALSE,
                    deleted_at TIMESTAMP WITHOUT TIME ZONE
                )
                """
            )
        )
        conn.execute(text("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS seen_at TIMESTAMP WITHOUT TIME ZONE"))
        conn.execute(text("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for_sender BOOLEAN DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for_receiver BOOLEAN DEFAULT FALSE"))
        conn.execute(
            text("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_for_everyone BOOLEAN DEFAULT FALSE")
        )
        conn.execute(text("ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITHOUT TIME ZONE"))
        conn.execute(text("UPDATE chat_messages SET deleted_for_sender = FALSE WHERE deleted_for_sender IS NULL"))
        conn.execute(text("UPDATE chat_messages SET deleted_for_receiver = FALSE WHERE deleted_for_receiver IS NULL"))
        conn.execute(text("UPDATE chat_messages SET deleted_for_everyone = FALSE WHERE deleted_for_everyone IS NULL"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_sender SET DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_receiver SET DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_everyone SET DEFAULT FALSE"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_sender SET NOT NULL"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_receiver SET NOT NULL"))
        conn.execute(text("ALTER TABLE chat_messages ALTER COLUMN deleted_for_everyone SET NOT NULL"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_sender_id ON chat_messages(sender_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_receiver_id ON chat_messages(receiver_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_created_at ON chat_messages(created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_seen_at ON chat_messages(seen_at)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_messages_deleted_for_sender ON chat_messages(deleted_for_sender)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_messages_deleted_for_receiver ON chat_messages(deleted_for_receiver)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_messages_deleted_for_everyone ON chat_messages(deleted_for_everyone)")
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_deleted_at ON chat_messages(deleted_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS user_feed_states (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
                    last_seen_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_feed_states_user_id ON user_feed_states(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_user_feed_states_last_seen_at ON user_feed_states(last_seen_at)"))
        conn.execute(
            text(
                """
                CREATE TABLE IF NOT EXISTS chat_typing_states (
                    id SERIAL PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    partner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    is_typing BOOLEAN NOT NULL DEFAULT FALSE,
                    updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW(),
                    CONSTRAINT uq_chat_typing_pair UNIQUE (user_id, partner_id)
                )
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_typing_states_user_id ON chat_typing_states(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_typing_states_partner_id ON chat_typing_states(partner_id)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_typing_states_is_typing ON chat_typing_states(is_typing)")
        )
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_chat_typing_states_updated_at ON chat_typing_states(updated_at)")
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_posts_author_id_created_at ON posts(author_id, created_at DESC)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_posts_created_at ON posts(created_at DESC)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_comments_post_id_created_at ON comments(post_id, created_at DESC)"))
        conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_notifications_recipient_id_created_at ON notifications(recipient_id, created_at DESC)")
        )
        conn.execute(
            text(
                """
                ALTER TABLE chat_messages
                ADD COLUMN IF NOT EXISTS conversation_id VARCHAR(64)
                """
            )
        )
        conn.execute(
            text(
                """
                UPDATE chat_messages
                SET conversation_id = CONCAT(LEAST(sender_id, receiver_id), ':', GREATEST(sender_id, receiver_id))
                WHERE conversation_id IS NULL
                """
            )
        )
        conn.execute(text("CREATE INDEX IF NOT EXISTS ix_chat_messages_conversation_id ON chat_messages(conversation_id)"))

def _initialize_database() -> None:
    Base.metadata.create_all(bind=engine)
    _ensure_schema()


@app.on_event("startup")
def _startup_database_init() -> None:
    try:
        _initialize_database()
    except OperationalError as exc:
        # Keep app import/start resilient when DB is temporarily unavailable.
        print(f"[startup] database init skipped: {exc}")
    _load_persisted_faiss_index()

app.mount("/static", StaticFiles(directory="static"), name="static")


def _page(name: str) -> FileResponse:
    page = Path(f"static/{name}")
    if not page.exists():
        raise HTTPException(status_code=404, detail="Frontend page not found")
    return FileResponse(page)


@app.get("/health")
def health():
    return {"status": "running"}


@app.get("/")
def home_page():
    return _page("landing.html")


@app.get("/about")
def about_page():
    return _page("about.html")


@app.get("/create-profile")
def create_profile_page():
    return _page("create-profile.html")


@app.get("/new-progress")
def new_progress_page():
    return _page("new-progress.html")


@app.get("/community-feed")
def community_feed_page():
    return _page("community-feed.html")


@app.get("/stories")
def stories_page():
    return _page("stories.html")


@app.get("/chats")
def chats_page():
    return _page("chats.html")


@app.get("/profile")
def profile_page():
    return _page("profile.html")


@app.get("/settings")
def settings_page():
    return _page("settings.html")


@app.get("/help-center")
def help_center_page():
    return _page("help-center.html")


@app.get("/user/{user_id}")
def public_user_page(user_id: int):
    return _page("user-profile.html")


@app.get("/post/{post_id}")
def shared_post_page(post_id: int):
    return _page("shared-post.html")


def _save_image(file: UploadFile) -> str:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Image file is required")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise HTTPException(status_code=400, detail="Unsupported image format")
    file_bytes = file.file.read()
    remote_url = _upload_bytes_to_s3(
        file_bytes,
        file.filename,
        folder="profile-photos",
        content_type=file.content_type or "",
    )
    if remote_url:
        return remote_url
    file_name = f"{uuid.uuid4().hex}{ext}"
    target = UPLOAD_DIR / file_name
    with target.open("wb") as buffer:
        buffer.write(file_bytes)
    return f"{UPLOAD_PATH_PREFIX}/{file_name}"


def _save_post_media(file: UploadFile) -> str:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Media file is required")

    ext = os.path.splitext(file.filename)[1].lower()
    allowed = ALLOWED_IMAGE_EXT | ALLOWED_VIDEO_EXT
    if ext not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported media format")

    file_bytes = file.file.read()
    remote_url = _upload_bytes_to_s3(
        file_bytes,
        file.filename,
        folder="posts",
        content_type=file.content_type or "",
    )
    if remote_url:
        return remote_url
    file_name = f"{uuid.uuid4().hex}{ext}"
    target = UPLOAD_DIR / file_name
    with target.open("wb") as buffer:
        buffer.write(file_bytes)
    return f"{UPLOAD_PATH_PREFIX}/{file_name}"


def _save_upload_file(file: UploadFile, allowed_ext: set[str]) -> tuple[str, str]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Story file is required")

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in allowed_ext:
        raise HTTPException(status_code=400, detail="Unsupported file format")

    file_name = f"{uuid.uuid4().hex}{ext}"
    target = UPLOAD_DIR / file_name
    with target.open("wb") as buffer:
        buffer.write(file.file.read())
    return file_name, f"{UPLOAD_PATH_PREFIX}/{file_name}"


def _ffprobe_duration_seconds(abs_path: Path) -> int:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(abs_path),
    ]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, text=True, timeout=20).strip()
        val = float(out)
        if val <= 0:
            return 1
        return max(1, int(val + 0.999))
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffprobe not installed. Install ffmpeg to use video stories.")
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read video duration")


def _split_video_to_minute_chunks(abs_path: Path, original_name: str) -> list[str]:
    stem = Path(original_name).stem
    ext = abs_path.suffix.lower()
    pattern = UPLOAD_DIR / f"{uuid.uuid4().hex}_{stem}_part_%03d{ext}"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(abs_path),
        "-c",
        "copy",
        "-map",
        "0",
        "-f",
        "segment",
        "-segment_time",
        "60",
        "-reset_timestamps",
        "1",
        str(pattern),
    ]
    try:
        subprocess.check_call(cmd, timeout=180)
    except FileNotFoundError:
        raise HTTPException(status_code=500, detail="ffmpeg not installed. Install ffmpeg to split long videos.")
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=500, detail="Video split failed. Try mp4 format.")
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="Video processing timed out")

    chunks = sorted(UPLOAD_DIR.glob(pattern.name.replace("%03d", "*")))
    if not chunks:
        raise HTTPException(status_code=500, detail="Video split produced no parts")
    return [f"{UPLOAD_PATH_PREFIX}/{chunk.name}" for chunk in chunks]


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120000)
    return f"{salt.hex()}${digest.hex()}"


def _hash_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _app_secret() -> str:
    return os.getenv("APP_SECRET", "dev-only-secret-change-me")


def _get_client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _create_captcha_token(answer: str, expires_at: int, nonce: str) -> str:
    payload = f"{expires_at}:{nonce}:{_hash_text(answer + nonce)}"
    sig = hmac.new(_app_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token_raw = f"{payload}:{sig}".encode("utf-8")
    return urlsafe_b64encode(token_raw).decode("utf-8")


def _verify_captcha_token(token: str, answer: str) -> bool:
    try:
        raw = urlsafe_b64decode(token.encode("utf-8")).decode("utf-8")
        expires_at_s, nonce, answer_hash, sig = raw.split(":", 3)
        payload = f"{expires_at_s}:{nonce}:{answer_hash}"
        expected_sig = hmac.new(_app_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected_sig):
            return False
        if int(expires_at_s) < int(time.time()):
            return False
        return _hash_text(answer.strip() + nonce) == answer_hash
    except Exception:
        return False


def _verify_password(password: str, stored_hash: str) -> bool:
    try:
        salt_hex, digest_hex = stored_hash.split("$", 1)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except Exception:
        return False
    computed = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 120000)
    return secrets.compare_digest(expected, computed)


def _normalize_mobile(country_code: str, mobile_number: str) -> str:
    cc = re.sub(r"\s+", "", (country_code or "").strip())
    number = re.sub(r"\s+", "", (mobile_number or "").strip())
    if not cc.startswith("+"):
        cc = f"+{cc.lstrip('+')}"
    if not re.fullmatch(r"\+\d{1,4}", cc):
        raise HTTPException(status_code=400, detail="Invalid country code")
    if not re.fullmatch(r"\d{6,14}", number):
        raise HTTPException(status_code=400, detail="Invalid mobile number")
    return f"{cc}{number}"


def _send_mobile_otp(mobile_number: str, otp: str) -> tuple[bool, str]:
    sms_provider = os.getenv("SMS_PROVIDER", "console").strip().lower()
    if sms_provider == "whatsapp_cloud":
        access_token = os.getenv("WHATSAPP_CLOUD_ACCESS_TOKEN", "").strip()
        phone_number_id = os.getenv("WHATSAPP_CLOUD_PHONE_NUMBER_ID", "").strip()
        template_name = os.getenv("WHATSAPP_CLOUD_TEMPLATE_NAME", "").strip()
        template_lang = os.getenv("WHATSAPP_CLOUD_TEMPLATE_LANG", "en_US").strip() or "en_US"
        include_expiry = os.getenv("WHATSAPP_CLOUD_TEMPLATE_INCLUDE_EXPIRY", "0").strip() == "1"
        if not access_token or not phone_number_id or not template_name:
            return (
                False,
                "WhatsApp Cloud API not configured. Set WHATSAPP_CLOUD_ACCESS_TOKEN, "
                "WHATSAPP_CLOUD_PHONE_NUMBER_ID and WHATSAPP_CLOUD_TEMPLATE_NAME.",
            )
        try:
            phone_digits = mobile_number.replace("+", "").strip()
            if not re.fullmatch(r"\d{7,18}", phone_digits):
                return False, "Invalid WhatsApp mobile number format."
            params = [{"type": "text", "text": otp}]
            if include_expiry:
                params.append({"type": "text", "text": "5"})

            payload = {
                "messaging_product": "whatsapp",
                "to": phone_digits,
                "type": "template",
                "template": {
                    "name": template_name,
                    "language": {"code": template_lang},
                    "components": [{"type": "body", "parameters": params}],
                },
            }
            api_url = f"https://graph.facebook.com/v21.0/{phone_number_id}/messages"
            req = request.Request(api_url, data=json.dumps(payload).encode("utf-8"), method="POST")
            req.add_header("Authorization", f"Bearer {access_token}")
            req.add_header("Content-Type", "application/json")
            with request.urlopen(req, timeout=20) as resp:
                body_text = resp.read().decode("utf-8", errors="ignore")
                if 200 <= resp.status < 300:
                    return True, "OTP sent on WhatsApp."
                return False, f"WhatsApp Cloud send failed: {body_text[:180]}"
        except Exception as exc:
            return False, f"WhatsApp Cloud send failed: {exc}"
    if sms_provider == "whatsapp_callmebot":
        api_key = os.getenv("WHATSAPP_CALLMEBOT_API_KEY", "").strip()
        if not api_key:
            return False, "WhatsApp provider not configured. Set WHATSAPP_CALLMEBOT_API_KEY in .env."
        try:
            phone_digits = mobile_number.replace("+", "").strip()
            if not re.fullmatch(r"\d{7,18}", phone_digits):
                return False, "Invalid WhatsApp mobile number format."
            text_msg = (
                "StepNix OTP Verification\n"
                f"Your OTP is: {otp}\n"
                "This OTP is valid for 5 minutes.\n"
                "Warning: Do not share this OTP with anyone."
            )
            encoded_text = parse.quote(text_msg, safe="")
            api_url = (
                "https://api.callmebot.com/whatsapp.php"
                f"?phone={phone_digits}&text={encoded_text}&apikey={parse.quote(api_key, safe='')}"
            )
            req = request.Request(api_url, method="GET")
            with request.urlopen(req, timeout=20) as resp:
                payload = resp.read().decode("utf-8", errors="ignore")
                if 200 <= resp.status < 300 and "ERROR" not in payload.upper():
                    return True, "OTP sent on WhatsApp."
                return False, f"WhatsApp send failed: {payload[:180]}"
        except Exception as exc:
            return False, f"WhatsApp send failed: {exc}"
    if sms_provider == "2factor":
        api_key = os.getenv("TWOFACTOR_API_KEY", "").strip()
        template_name = os.getenv("TWOFACTOR_TEMPLATE", "StepNix").strip() or "StepNix"
        if not api_key:
            return False, "2Factor is not configured. Set TWOFACTOR_API_KEY in .env."
        try:
            encoded_to = parse.quote(mobile_number, safe="")
            encoded_template = parse.quote(template_name, safe="")
            api_url = f"https://2factor.in/API/V1/{api_key}/SMS/{encoded_to}/{otp}/{encoded_template}"
            req = request.Request(api_url, method="GET")
            with request.urlopen(req, timeout=20) as resp:
                payload = resp.read().decode("utf-8", errors="ignore")
                if 200 <= resp.status < 300 and "Success" in payload:
                    return True, "OTP sent."
                return False, f"2Factor send failed: {payload[:180]}"
        except Exception as exc:
            return False, f"2Factor send failed: {exc}"
    if sms_provider == "twilio":
        account_sid = os.getenv("TWILIO_ACCOUNT_SID", "").strip()
        auth_token = os.getenv("TWILIO_AUTH_TOKEN", "").strip()
        from_number = os.getenv("TWILIO_FROM_NUMBER", "").strip()
        if not account_sid or not auth_token or not from_number:
            return (
                False,
                "Twilio is not fully configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.",
            )
        api_url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
        body = parse.urlencode(
            {
                "From": from_number,
                "To": mobile_number,
                "Body": f"Your StepNix chat OTP is {otp}. It expires in 5 minutes.",
            }
        ).encode("utf-8")
        req = request.Request(api_url, data=body, method="POST")
        token_raw = f"{account_sid}:{auth_token}".encode("utf-8")
        basic = b64encode(token_raw).decode("utf-8")
        req.add_header("Authorization", f"Basic {basic}")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        try:
            with request.urlopen(req, timeout=20) as resp:
                if 200 <= resp.status < 300:
                    return True, "OTP sent."
                return False, "Failed to send OTP via Twilio."
        except Exception as exc:
            return False, f"Twilio send failed: {exc}"
    if sms_provider in {"", "console"}:
        print(f"[CHAT_OTP] {mobile_number} -> {otp}")
        return True, "OTP sent."
    # Placeholder for external SMS providers (Twilio, MSG91, etc.)
    return False, (
        "Provider not configured. Use SMS_PROVIDER=whatsapp_cloud, SMS_PROVIDER=whatsapp_callmebot, "
        "SMS_PROVIDER=2factor, or SMS_PROVIDER=twilio."
    )


def _build_chat_message_out(row: ChatMessage, db: Session, viewer_id: int) -> ChatMessageOut:
    sender = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == row.sender_id)).scalars().first()
    receiver = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == row.receiver_id)).scalars().first()
    if not sender or not receiver:
        raise HTTPException(status_code=404, detail="User not found")
    content = "This message was deleted" if row.deleted_for_everyone else row.content
    return ChatMessageOut(
        id=row.id,
        sender=_build_user_out(sender, db, viewer_id),
        receiver=_build_user_out(receiver, db, viewer_id),
        content=content,
        created_at=row.created_at,
        seen_at=row.seen_at,
        deleted_for_everyone=row.deleted_for_everyone,
        can_delete_for_everyone=(viewer_id == row.sender_id and not row.deleted_for_everyone),
    )


def _is_chat_message_hidden_for_user(row: ChatMessage, viewer_id: int) -> bool:
    if viewer_id == row.sender_id and row.deleted_for_sender:
        return True
    if viewer_id == row.receiver_id and row.deleted_for_receiver:
        return True
    return False


def _public_media_url(path: str | None) -> str | None:
    if not path:
        return None
    value = str(path).strip()
    if not value:
        return None
    if value.startswith("http://") or value.startswith("https://"):
        return value
    return f"/{value.lstrip('/')}"


def _build_user_out(user: User, db: Session, viewer_id: int | None = None) -> UserOut:
    image_path = user.profile_photo.image_path if user.profile_photo else None
    photo_url = _public_media_url(image_path)
    if viewer_id and viewer_id != user.id and _is_visibility_hidden(user.id, viewer_id, "profile", db):
        # "Hide profile" rule now hides only DP for selected viewers.
        photo_url = None
    post_count = db.query(Post).filter(Post.author_id == user.id).count()
    follower_count = db.query(UserFollow).filter(UserFollow.following_id == user.id).count()
    following_count = db.query(UserFollow).filter(UserFollow.follower_id == user.id).count()
    is_following = False
    if viewer_id and viewer_id != user.id:
        is_following = (
            db.execute(
                select(UserFollow).where(
                    UserFollow.follower_id == viewer_id,
                    UserFollow.following_id == user.id,
                )
            )
            .scalars()
            .first()
            is not None
        )
    return UserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        gender=(user.gender or "prefer_not_to_say"),
        full_name=user.full_name,
        bio=user.bio,
        profile_photo_url=photo_url,
        post_count=post_count,
        follower_count=follower_count,
        following_count=following_count,
        current_streak=max(0, int(user.current_streak or 0)),
        is_following=is_following,
    )


def _build_notification_actor_out(user: User) -> NotificationActorOut:
    image_path = user.profile_photo.image_path if user.profile_photo else None
    return NotificationActorOut(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        profile_photo_url=_public_media_url(image_path),
    )


def _build_comment_reaction_user_out(user: User) -> CommentReactionUserOut:
    image_path = user.profile_photo.image_path if user.profile_photo else None
    return CommentReactionUserOut(
        id=user.id,
        username=user.username,
        full_name=user.full_name,
        profile_photo_url=_public_media_url(image_path),
    )


def _build_notification_out(notification: Notification) -> NotificationOut:
    return NotificationOut(
        id=notification.id,
        event_type=notification.event_type,
        title=notification.title,
        message=notification.message,
        post_id=notification.post_id,
        comment_id=notification.comment_id,
        is_read=notification.is_read,
        created_at=notification.created_at,
        actor=_build_notification_actor_out(notification.actor),
    )


def _mentioned_user_ids(*texts: str, db: Session, exclude_ids: set[int] | None = None) -> set[int]:
    usernames: set[str] = set()
    for text in texts:
        usernames.update({name.strip().lower() for name in MENTION_PATTERN.findall(text or "") if name.strip()})
    if not usernames:
        return set()
    excluded = exclude_ids or set()
    rows = db.execute(select(User.id).where(User.username.in_(sorted(usernames)))).all()
    return {int(row[0]) for row in rows if int(row[0]) not in excluded}


def _create_notifications(
    db: Session,
    recipient_ids: set[int] | list[int],
    actor_id: int,
    event_type: str,
    title: str,
    message: str = "",
    post_id: int | None = None,
    comment_id: int | None = None,
) -> list[Notification]:
    unique_ids = {rid for rid in recipient_ids if rid and rid != actor_id}
    if not unique_ids:
        return []
    created = [
        Notification(
            recipient_id=rid,
            actor_id=actor_id,
            event_type=event_type,
            title=title[:180],
            message=message[:350],
            post_id=post_id,
            comment_id=comment_id,
        )
        for rid in unique_ids
    ]
    db.add_all(created)
    db.flush()
    return created


def _publish_notification_rows(rows: list[Notification]) -> None:
    for row in rows:
        payload = {
            "type": "notification",
            "notification": _build_notification_out(row).model_dump(mode="json"),
        }
        _redis_publish(f"notifications:{row.recipient_id}", payload)
        notification_hub.publish(row.recipient_id, payload)
    if rows:
        _invalidate_notification_counts(*[row.recipient_id for row in rows])


def _send_otp_email(
    target_email: str,
    otp: str,
    *,
    subject: str = "Your OTP for password reset",
    content: str | None = None,
) -> tuple[bool, str]:
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    smtp_port_raw = (os.getenv("SMTP_PORT") or "587").strip()
    smtp_user = (os.getenv("SMTP_USER") or "").strip()
    smtp_password_raw = os.getenv("SMTP_PASSWORD") or ""
    # Gmail app-password is often copied with spaces; normalize it.
    smtp_password = "".join(smtp_password_raw.strip().split())
    smtp_sender = (os.getenv("SMTP_SENDER") or smtp_user or "no-reply@example.com").strip()

    try:
        smtp_port = int(smtp_port_raw)
    except ValueError:
        return False, "SMTP_PORT must be a valid integer"

    if not smtp_host or not smtp_user or not smtp_password:
        return False, "SMTP settings missing"

    def _send_email(subject: str, content: str) -> tuple[bool, str]:
        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = smtp_sender
        msg["To"] = target_email
        msg.set_content(content)

        try:
            if smtp_port == 465:
                with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=15) as server:
                    server.login(smtp_user, smtp_password)
                    server.send_message(msg)
            else:
                with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
                    server.ehlo()
                    server.starttls()
                    server.ehlo()
                    server.login(smtp_user, smtp_password)
                    server.send_message(msg)
            return True, "Email sent"
        except smtplib.SMTPAuthenticationError:
            return (
                False,
                "SMTP authentication failed. For Gmail, enable 2-Step Verification and use a 16-character App Password.",
            )
        except (smtplib.SMTPException, OSError) as exc:
            return False, f"SMTP delivery failed: {exc}"

    return _send_email(
        subject=subject,
        content=content or f"Your OTP is {otp}. It expires in {OTP_EXPIRY_MINUTES} minutes.",
    )


def _generate_chat_secret_code(length: int = 8) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789@#$%!?*"
    special = "@#$%!?*"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(ch in special for ch in code):
            return code


def _send_chat_auth_email(target_email: str, otp: str, secret_code: str) -> tuple[bool, str]:
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    smtp_port_raw = (os.getenv("SMTP_PORT") or "587").strip()
    smtp_user = (os.getenv("SMTP_USER") or "").strip()
    smtp_password_raw = os.getenv("SMTP_PASSWORD") or ""
    smtp_password = "".join(smtp_password_raw.strip().split())
    smtp_sender = (os.getenv("SMTP_SENDER") or smtp_user or "no-reply@example.com").strip()

    try:
        smtp_port = int(smtp_port_raw)
    except ValueError:
        return False, "SMTP_PORT must be a valid integer"

    if not smtp_host or not smtp_user or not smtp_password:
        return False, "SMTP settings missing"

    message = (
        "Hello from StepNix Team,\n\n"
        "Thank you for reaching out to us.\n\n"
        f"Your OTP: {otp}\n"
        f"Your Secret Code: {secret_code}\n\n"
        "Both values are valid for 5 minutes.\n"
        "Please do not share these values with anyone.\n\n"
        "Regards,\n"
        "StepNix Team"
    )
    msg = EmailMessage()
    msg["Subject"] = "StepNix chat verification OTP and secret code"
    msg["From"] = smtp_sender
    msg["To"] = target_email
    msg.set_content(message)

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=15) as server:
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
        return True, "Email sent"
    except smtplib.SMTPAuthenticationError:
        return (
            False,
            "SMTP authentication failed. For Gmail, enable 2-Step Verification and use a 16-character App Password.",
        )
    except (smtplib.SMTPException, OSError) as exc:
        return False, f"SMTP delivery failed: {exc}"


def _send_plain_email(target_email: str, subject: str, content: str) -> tuple[bool, str]:
    smtp_host = (os.getenv("SMTP_HOST") or "").strip()
    smtp_port_raw = (os.getenv("SMTP_PORT") or "587").strip()
    smtp_user = (os.getenv("SMTP_USER") or "").strip()
    smtp_password_raw = os.getenv("SMTP_PASSWORD") or ""
    smtp_password = "".join(smtp_password_raw.strip().split())
    smtp_sender = (os.getenv("SMTP_SENDER") or smtp_user or "no-reply@example.com").strip()

    try:
        smtp_port = int(smtp_port_raw)
    except ValueError:
        return False, "SMTP_PORT must be a valid integer"

    if not smtp_host or not smtp_user or not smtp_password:
        return False, "SMTP settings missing"

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp_sender
    msg["To"] = target_email
    msg.set_content(content)

    try:
        if smtp_port == 465:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, timeout=15) as server:
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(smtp_host, smtp_port, timeout=15) as server:
                server.ehlo()
                server.starttls()
                server.ehlo()
                server.login(smtp_user, smtp_password)
                server.send_message(msg)
        return True, "Email sent"
    except smtplib.SMTPAuthenticationError:
        return (
            False,
            "SMTP authentication failed. For Gmail, enable 2-Step Verification and use a 16-character App Password.",
        )
    except (smtplib.SMTPException, OSError) as exc:
        return False, f"SMTP delivery failed: {exc}"


def _queue_plain_email(background_tasks: BackgroundTasks | None, target_email: str, subject: str, content: str) -> None:
    email_clean = (target_email or "").strip().lower()
    if not email_clean:
        return
    if background_tasks is None:
        _send_plain_email(email_clean, subject, content)
        return
    background_tasks.add_task(_send_plain_email, email_clean, subject, content)


def _build_post_out(
    post: Post,
    db: Session,
    viewer_id: int | None = None,
    new_streak_count: int = 0,
    streak_just_increased: bool = False,
) -> PostOut:
    liked_by_me = False
    if viewer_id:
        liked_by_me = any(like.user_id == viewer_id for like in post.likes)
    return PostOut(
        id=post.id,
        author=_build_user_out(post.author, db, viewer_id),
        goal_title=post.goal_title,
        caption=post.caption,
        day_experience=post.day_experience,
        screenshots=[_public_media_url(image.image_path) or "" for image in post.screenshots],
        like_count=len(post.likes),
        liked_by_me=liked_by_me,
        comment_count=len(post.comments),
        new_streak_count=max(0, int(new_streak_count or 0)),
        streak_just_increased=bool(streak_just_increased),
        created_at=post.created_at,
    )


def _is_video_path(path: str | None) -> bool:
    if not path:
        return False
    clean = str(path).split("?", 1)[0].lower()
    return clean.endswith((".mp4", ".mov", ".m4v", ".webm"))


def _is_valid_email(email: str) -> bool:
    return bool(EMAIL_PATTERN.fullmatch((email or "").strip()))


def _story_cutoff() -> datetime:
    return datetime.utcnow() - timedelta(hours=24)


def _resolve_streak_for_local_post(
    user: User,
    *,
    timezone_offset_minutes: int,
    now_utc: datetime | None = None,
) -> tuple[int, bool]:
    offset_minutes = max(-840, min(840, int(timezone_offset_minutes or 0)))
    current_utc = (now_utc or datetime.utcnow()).replace(microsecond=0)
    current_utc_aware = current_utc.replace(tzinfo=timezone.utc)
    local_today = (current_utc_aware - timedelta(minutes=offset_minutes)).date()

    previous_streak = max(0, int(user.current_streak or 0))
    last_post_value = user.last_post_date
    if not last_post_value:
        return 1, previous_streak < 1

    last_post_utc = last_post_value.replace(tzinfo=timezone.utc)
    last_local_date = (last_post_utc - timedelta(minutes=offset_minutes)).date()
    day_gap = (local_today - last_local_date).days

    if day_gap == 0:
        resolved = previous_streak if previous_streak > 0 else 1
        return resolved, resolved > previous_streak
    if day_gap == 1:
        base_streak = previous_streak if previous_streak > 0 else 1
        resolved = base_streak + 1
        return resolved, resolved > previous_streak
    return 1, previous_streak < 1


def _build_story_out(story: Story, viewer_id: int | None = None) -> StoryOut:
    viewed = False
    if viewer_id:
        viewed = any(view.viewer_id == viewer_id for view in story.views)
    return StoryOut(
        id=story.id,
        media_url=_public_media_url(story.media_path) or "",
        media_type=story.media_type,
        duration_seconds=story.duration_seconds,
        caption=story.caption,
        sticker_data=_parse_sticker_data(story.sticker_data),
        created_at=story.created_at,
        viewed_by_me=viewed,
    )


def _sanitize_sticker_data(raw: str) -> str:
    if not raw or not raw.strip():
        return ""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid sticker data")
    if not isinstance(parsed, list):
        raise HTTPException(status_code=400, detail="Invalid sticker data")

    cleaned: list[dict[str, str | int | float]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        text = text[:24]
        try:
            x = float(item.get("x", 50))
            y = float(item.get("y", 50))
            scale = float(item.get("scale", 1))
            rotate = float(item.get("rotate", 0))
        except (TypeError, ValueError):
            continue
        x = max(0.0, min(100.0, x))
        y = max(0.0, min(100.0, y))
        scale = max(0.5, min(2.5, scale))
        rotate = max(-180.0, min(180.0, rotate))
        cleaned.append(
            {
                "text": text,
                "x": round(x, 2),
                "y": round(y, 2),
                "scale": round(scale, 2),
                "rotate": round(rotate, 1),
            }
        )
        if len(cleaned) >= 25:
            break

    return json.dumps(cleaned, separators=(",", ":")) if cleaned else ""


def _parse_sticker_data(raw: str) -> list[dict[str, str | int | float]]:
    if not raw or not raw.strip():
        return []
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list):
        return []
    output: list[dict[str, str | int | float]] = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        output.append(
            {
                "text": text[:24],
                "x": float(item.get("x", 50)),
                "y": float(item.get("y", 50)),
                "scale": float(item.get("scale", 1)),
                "rotate": float(item.get("rotate", 0)),
            }
        )
    return output


def _reaction_summary(comment: Comment) -> tuple[int, dict[str, int]]:
    summary: dict[str, int] = {}
    for reaction in comment.reactions:
        summary[reaction.reaction_type] = summary.get(reaction.reaction_type, 0) + 1
    return len(comment.reactions), summary


def _chat_notification_preview(raw_content: str) -> str:
    content = (raw_content or "").strip()
    if not content:
        return "Sent you a message."
    story_match = re.match(r"^\[\[STEPNIX_SHARE_STORY:(\d+)\]\](?:\n([\s\S]*))?$", content)
    if story_match:
        reply_text = (story_match.group(2) or "").strip()
        return f"Shared a story: {reply_text[:120]}" if reply_text else "Shared a story with you."
    post_match = re.match(r"^\[\[STEPNIX_SHARE_POST:(\d+)\]\](?:\n([\s\S]*))?$", content)
    if post_match:
        reply_text = (post_match.group(2) or "").strip()
        return f"Shared a post: {reply_text[:120]}" if reply_text else "Shared a post with you."
    return content[:160]


def _require_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Login required")

    token_value = authorization.split(" ", 1)[1].strip()
    token = (
        db.execute(select(AuthToken).options(joinedload(AuthToken.user).joinedload(User.profile_photo)).where(AuthToken.token == token_value))
        .scalars()
        .first()
    )
    if not token or not token.user:
        raise HTTPException(status_code=401, detail="Invalid token")
    return token.user


def _optional_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token_value = authorization.split(" ", 1)[1].strip()
    token = (
        db.execute(select(AuthToken).options(joinedload(AuthToken.user)).where(AuthToken.token == token_value))
        .scalars()
        .first()
    )
    if not token or not token.user:
        return None
    return token.user


def _user_from_token_value(token_value: str, db: Session) -> User | None:
    clean = (token_value or "").strip()
    if not clean:
        return None
    token = (
        db.execute(
            select(AuthToken)
            .options(joinedload(AuthToken.user).joinedload(User.profile_photo))
            .where(AuthToken.token == clean)
        )
        .scalars()
        .first()
    )
    if not token or not token.user:
        return None
    return token.user


def _require_chat_session(
    current_user: User = Depends(_require_user),
    x_chat_token: str | None = Header(default=None),
    x_device_id: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    if not x_chat_token:
        raise HTTPException(status_code=401, detail="Chat login required")
    session = (
        db.execute(select(ChatDeviceSession).where(ChatDeviceSession.session_token == x_chat_token.strip()))
        .scalars()
        .first()
    )
    if not session or session.user_id != current_user.id:
        raise HTTPException(status_code=401, detail="Chat session expired. Verify email again.")
    if x_device_id and session.device_id != x_device_id.strip():
        raise HTTPException(status_code=401, detail="Chat session belongs to another device.")
    session.last_active_at = datetime.utcnow()
    db.commit()
    return current_user


@app.post("/api/auth/register/send-otp")
def register_send_otp(
    email: str = Form(...),
    db: Session = Depends(get_db),
):
    email_clean = email.strip().lower()
    if not _is_valid_email(email_clean):
        raise HTTPException(status_code=400, detail="Valid email is required")

    existing_email = db.execute(select(User).where(User.email == email_clean)).scalars().first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already registered")

    now = datetime.utcnow()
    latest = (
        db.execute(
            select(RegistrationEmailOTP)
            .where(RegistrationEmailOTP.email == email_clean)
            .order_by(desc(RegistrationEmailOTP.created_at))
        )
        .scalars()
        .first()
    )
    if latest:
        diff = (now - latest.created_at).total_seconds()
        if diff < OTP_COOLDOWN_SECONDS:
            wait = int(OTP_COOLDOWN_SECONDS - diff)
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP")

    otp = f"{secrets.randbelow(1000000):06d}"
    db.add(
        RegistrationEmailOTP(
            email=email_clean,
            otp_hash=_hash_text(otp),
            expires_at=now + timedelta(minutes=OTP_EXPIRY_MINUTES),
            is_used=False,
        )
    )

    delivered, mail_status = _send_otp_email(
        email_clean,
        otp,
        subject="Your OTP for StepNix account registration",
        content=f"Your StepNix registration OTP is {otp}. It expires in {OTP_EXPIRY_MINUTES} minutes.",
    )
    if delivered:
        db.commit()
        return {"detail": "Verification code sent to your email."}
    if APP_ENV == "development":
        db.commit()
        return {
            "detail": f"Email delivery failed ({mail_status}). Using dev OTP for local testing.",
            "dev_otp": otp,
        }
    db.rollback()
    raise HTTPException(status_code=500, detail=mail_status)


@app.post("/api/auth/register/verify-otp")
def register_verify_otp(
    email: str = Form(...),
    otp: str = Form(...),
    db: Session = Depends(get_db),
):
    email_clean = email.strip().lower()
    if not _is_valid_email(email_clean):
        raise HTTPException(status_code=400, detail="Valid email is required")
    otp_clean = otp.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit verification code")

    row = (
        db.execute(
            select(RegistrationEmailOTP)
            .where(
                RegistrationEmailOTP.email == email_clean,
                RegistrationEmailOTP.is_used.is_(False),
            )
            .order_by(desc(RegistrationEmailOTP.created_at))
        )
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=400, detail="Verification code not found. Request a new one.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="Verification code expired. Request a new one.")
    if row.otp_hash != _hash_text(otp_clean):
        raise HTTPException(status_code=400, detail="Invalid verification code")
    return {"detail": "OTP verified. You can create account now."}


@app.post("/api/auth/register", response_model=AuthOut)
def register(
    username: str = Form(...),
    email: str = Form(...),
    email_otp: str = Form(...),
    gender: str = Form("prefer_not_to_say"),
    full_name: str = Form(...),
    bio: str = Form(""),
    password: str = Form(...),
    profile_photo: UploadFile | None = File(default=None),
    db: Session = Depends(get_db),
):
    if len(password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    email_clean = email.strip().lower()
    if not _is_valid_email(email_clean):
        raise HTTPException(status_code=400, detail="Valid email is required")

    existing_email = db.execute(select(User).where(User.email == email_clean)).scalars().first()
    if existing_email:
        raise HTTPException(status_code=400, detail="Email already registered")
    gender_clean = (gender or "").strip().lower()
    if gender_clean not in ALLOWED_GENDERS:
        raise HTTPException(status_code=400, detail="Select a valid gender")
    otp_clean = email_otp.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit verification code")
    otp_row = (
        db.execute(
            select(RegistrationEmailOTP)
            .where(
                RegistrationEmailOTP.email == email_clean,
                RegistrationEmailOTP.is_used.is_(False),
            )
            .order_by(desc(RegistrationEmailOTP.created_at))
        )
        .scalars()
        .first()
    )
    if not otp_row:
        raise HTTPException(status_code=400, detail="Verification code not found. Request a new one.")
    if otp_row.expires_at < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(status_code=400, detail="Verification code expired. Request a new one.")
    if otp_row.otp_hash != _hash_text(otp_clean):
        raise HTTPException(status_code=400, detail="Invalid verification code")

    user = User(
        username=username.strip().lower(),
        email=email_clean,
        gender=gender_clean,
        full_name=full_name.strip(),
        bio=bio.strip(),
        password_hash=_hash_password(password),
    )
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="Username already exists")

    if profile_photo and profile_photo.filename:
        photo_path = _save_image(profile_photo)
        db.add(UserProfilePhoto(user_id=user.id, image_path=photo_path))

    token_value = secrets.token_urlsafe(32)
    db.add(AuthToken(user_id=user.id, token=token_value))
    otp_row.is_used = True
    db.commit()

    created = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user.id)).scalars().first()
    )
    if not created:
        raise HTTPException(status_code=500, detail="Failed to load user")

    return AuthOut(token=token_value, user=_build_user_out(created, db, created.id))


@app.post("/api/auth/login", response_model=AuthOut)
def login(
    payload: LoginIn,
    request: Request,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    ident = payload.identifier.strip().lower()
    user = (
        db.execute(
            select(User)
            .options(joinedload(User.profile_photo))
            .where((User.username == ident) | (User.email == ident))
        )
        .scalars()
        .first()
    )
    if not user or not _verify_password(payload.password, user.password_hash):
        if user and (user.email or "").strip():
            ip_address = _get_client_ip(request)
            _queue_plain_email(
                background_tasks,
                user.email,
                "StepNix login attempt alert",
                (
                    "A failed login attempt was detected for your StepNix account.\n\n"
                    f"Username: @{user.username}\n"
                    f"Time (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}\n"
                    f"IP Address: {ip_address}\n\n"
                    "If this was not you, reset your password immediately."
                ),
            )
        raise HTTPException(status_code=401, detail="Invalid username/email or password")

    token_value = secrets.token_urlsafe(32)
    db.add(AuthToken(user_id=user.id, token=token_value))
    db.commit()
    if (user.email or "").strip():
        ip_address = _get_client_ip(request)
        _queue_plain_email(
            background_tasks,
            user.email,
            "StepNix login alert",
            (
                "A successful login was detected for your StepNix account.\n\n"
                f"Username: @{user.username}\n"
                f"Time (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}\n"
                f"IP Address: {ip_address}\n\n"
                "If this was not you, secure your account immediately."
            ),
        )
    return AuthOut(token=token_value, user=_build_user_out(user, db, user.id))


@app.get("/api/auth/forgot-password/captcha")
def forgot_password_captcha():
    a = secrets.randbelow(9) + 1
    b = secrets.randbelow(9) + 1
    nonce = secrets.token_hex(8)
    expires_at = int(time.time()) + 300
    token = _create_captcha_token(str(a + b), expires_at, nonce)
    return {"question": f"What is {a} + {b}?", "captcha_token": token}


@app.post("/api/auth/forgot-password")
def forgot_password(
    request: Request,
    email: str = Form(...),
    captcha_token: str = Form(...),
    captcha_answer: str = Form(...),
    db: Session = Depends(get_db),
):
    if not _verify_captcha_token(captcha_token, captcha_answer):
        raise HTTPException(status_code=400, detail="Captcha verification failed")

    email_clean = email.strip().lower()
    ip_address = _get_client_ip(request)
    now = datetime.utcnow()
    if ENFORCE_OTP_LIMITS:
        window_10 = now - timedelta(minutes=10)
        window_day = now - timedelta(days=1)

        email_recent = (
            db.execute(
                select(PasswordResetAttempt)
                .where(PasswordResetAttempt.email == email_clean, PasswordResetAttempt.created_at >= window_10)
                .order_by(PasswordResetAttempt.created_at.desc())
            )
            .scalars()
            .all()
        )
        ip_recent = (
            db.execute(
                select(PasswordResetAttempt)
                .where(PasswordResetAttempt.ip_address == ip_address, PasswordResetAttempt.created_at >= window_10)
                .order_by(PasswordResetAttempt.created_at.desc())
            )
            .scalars()
            .all()
        )
        email_daily_count = (
            db.execute(
                select(PasswordResetAttempt)
                .where(PasswordResetAttempt.email == email_clean, PasswordResetAttempt.created_at >= window_day)
            )
            .scalars()
            .all()
        )

        if email_recent:
            latest = email_recent[0]
            diff = (now - latest.created_at).total_seconds()
            if diff < OTP_COOLDOWN_SECONDS:
                wait = int(OTP_COOLDOWN_SECONDS - diff)
                raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP")
        if len(email_recent) >= OTP_MAX_PER_10_MIN or len(ip_recent) >= OTP_MAX_PER_10_MIN:
            raise HTTPException(status_code=429, detail="Too many OTP requests. Try again in 10 minutes")
        if len(email_daily_count) >= OTP_MAX_PER_DAY:
            raise HTTPException(status_code=429, detail="Daily OTP limit reached for this account")

    user = db.execute(select(User).where(User.email == email_clean)).scalars().first()
    db.add(
        PasswordResetAttempt(
            user_id=user.id if user else None,
            email=email_clean,
            ip_address=ip_address,
            created_at=now,
        )
    )
    db.commit()

    if not user:
        raise HTTPException(status_code=404, detail="No account found with this email")

    otp = f"{secrets.randbelow(1000000):06d}"
    otp_hash = _hash_text(otp)
    expires_at = datetime.utcnow() + timedelta(minutes=OTP_EXPIRY_MINUTES)

    existing_rows = db.execute(select(PasswordResetOTP).where(PasswordResetOTP.user_id == user.id)).scalars().all()
    for row in existing_rows:
        db.delete(row)

    db.add(PasswordResetOTP(user_id=user.id, otp_hash=otp_hash, is_verified=False, expires_at=expires_at))
    db.commit()
    delivered, mail_status = _send_otp_email(email_clean, otp)
    if delivered:
        return {"detail": "OTP sent to your email."}
    if APP_ENV == "development":
        return {
            "detail": f"Email delivery failed ({mail_status}). Using dev OTP for local testing.",
            "dev_otp": otp,
        }
    raise HTTPException(status_code=500, detail=mail_status)


@app.post("/api/auth/verify-otp")
def verify_otp(
    email: str = Form(...),
    otp: str = Form(...),
    db: Session = Depends(get_db),
):
    email_clean = email.strip().lower()
    user = db.execute(select(User).where(User.email == email_clean)).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or OTP")

    otp_row = (
        db.execute(select(PasswordResetOTP).where(PasswordResetOTP.user_id == user.id))
        .scalars()
        .first()
    )
    if not otp_row:
        raise HTTPException(status_code=400, detail="OTP not found or expired")
    if otp_row.expires_at < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired")
    if otp_row.otp_hash != _hash_text(otp.strip()):
        raise HTTPException(status_code=400, detail="Invalid email or OTP")

    otp_row.is_verified = True
    db.commit()
    return {"detail": "OTP verified. You can reset your password now."}


@app.post("/api/auth/reset-password")
def reset_password(
    email: str = Form(...),
    new_password: str = Form(...),
    db: Session = Depends(get_db),
):
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    email_clean = email.strip().lower()
    user = db.execute(select(User).where(User.email == email_clean)).scalars().first()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid email or OTP")

    otp_row = (
        db.execute(select(PasswordResetOTP).where(PasswordResetOTP.user_id == user.id))
        .scalars()
        .first()
    )
    if not otp_row:
        raise HTTPException(status_code=400, detail="OTP not found or expired")
    if otp_row.expires_at < datetime.utcnow():
        db.delete(otp_row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired")
    if not otp_row.is_verified:
        raise HTTPException(status_code=400, detail="Verify OTP first")

    user.password_hash = _hash_password(new_password)
    db.delete(otp_row)
    db.commit()
    return {"detail": "Password reset successful. Please login."}


@app.post("/api/auth/logout")
def logout(current_user: User = Depends(_require_user), authorization: str | None = Header(default=None), db: Session = Depends(get_db)):
    if not authorization:
        return {"detail": "Logged out"}
    token_value = authorization.split(" ", 1)[1].strip()
    token = db.execute(select(AuthToken).where(AuthToken.token == token_value)).scalars().first()
    if token and token.user_id == current_user.id:
        db.delete(token)
        db.commit()
    return {"detail": "Logged out"}


@app.get("/api/auth/me", response_model=UserOut)
def me(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    return _build_user_out(current_user, db, current_user.id)


@app.get("/api/settings/account/dashboard")
def settings_account_dashboard(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    now = datetime.utcnow()
    thirty_days_ago = now - timedelta(days=30)
    rows = (
        db.execute(
            select(ProfileView)
            .options(joinedload(ProfileView.viewer).joinedload(User.profile_photo))
            .where(ProfileView.viewed_user_id == current_user.id)
            .order_by(desc(ProfileView.created_at))
        )
        .scalars()
        .all()
    )

    total_views = len(rows)
    views_last_30_days = sum(1 for row in rows if row.created_at >= thirty_days_ago)

    latest_by_viewer: dict[int, ProfileView] = {}
    count_by_viewer: dict[int, int] = {}
    for row in rows:
        if row.viewer_id == current_user.id:
            continue
        count_by_viewer[row.viewer_id] = count_by_viewer.get(row.viewer_id, 0) + 1
        if row.viewer_id not in latest_by_viewer:
            latest_by_viewer[row.viewer_id] = row

    unique_viewers = len(latest_by_viewer)
    recent_viewers = []
    for viewer_id, row in list(latest_by_viewer.items())[:30]:
        viewer = row.viewer
        if not viewer:
            continue
        recent_viewers.append(
            {
                "id": viewer.id,
                "username": viewer.username,
                "full_name": viewer.full_name,
                "gender": viewer.gender or "prefer_not_to_say",
                "profile_photo_url": _public_media_url(viewer.profile_photo.image_path) if viewer.profile_photo else None,
                "last_viewed_at": row.created_at.isoformat(),
                "view_count": count_by_viewer.get(viewer_id, 1),
            }
        )

    gender_counts = {"male": 0, "female": 0, "prefer_not_to_say": 0}
    for row in latest_by_viewer.values():
        gender = (row.viewer.gender or "prefer_not_to_say") if row.viewer else "prefer_not_to_say"
        if gender not in gender_counts:
            gender = "prefer_not_to_say"
        gender_counts[gender] += 1

    denom = max(1, unique_viewers)
    gender_ratio = [
        {
            "key": "male",
            "label": "Male",
            "count": gender_counts["male"],
            "percent": round((gender_counts["male"] * 100.0) / denom, 1),
        },
        {
            "key": "female",
            "label": "Female",
            "count": gender_counts["female"],
            "percent": round((gender_counts["female"] * 100.0) / denom, 1),
        },
        {
            "key": "prefer_not_to_say",
            "label": "Prefer not to say",
            "count": gender_counts["prefer_not_to_say"],
            "percent": round((gender_counts["prefer_not_to_say"] * 100.0) / denom, 1),
        },
    ]
    return {
        "total_views": total_views,
        "views_last_30_days": views_last_30_days,
        "unique_viewers": unique_viewers,
        "gender_ratio": gender_ratio,
        "recent_viewers": recent_viewers,
    }


def _parse_target_user_ids(raw_value: str) -> list[int]:
    if not raw_value.strip():
        return []
    values: list[int] = []
    for chunk in raw_value.split(","):
        text_value = chunk.strip()
        if not text_value:
            continue
        try:
            values.append(int(text_value))
        except ValueError:
            continue
    return sorted({value for value in values if value > 0})


@app.get("/api/settings/security/state")
def settings_security_state(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    setting = _get_or_create_privacy_setting(current_user.id, db)
    hidden_story_ids = {
        row.target_user_id
        for row in db.execute(
            select(UserVisibilityRule).where(
                UserVisibilityRule.owner_id == current_user.id,
                UserVisibilityRule.rule_type == "story",
            )
        )
        .scalars()
        .all()
    }
    hidden_profile_ids = {
        row.target_user_id
        for row in db.execute(
            select(UserVisibilityRule).where(
                UserVisibilityRule.owner_id == current_user.id,
                UserVisibilityRule.rule_type == "profile",
            )
        )
        .scalars()
        .all()
    }
    blocked_ids = {
        row.blocked_user_id
        for row in db.execute(select(UserBlock).where(UserBlock.blocker_id == current_user.id)).scalars().all()
    }
    return {
        "show_message_seen": bool(setting.show_message_seen),
        "hidden_story_user_ids": sorted(hidden_story_ids),
        "hidden_profile_user_ids": sorted(hidden_profile_ids),
        "blocked_user_ids": sorted(blocked_ids),
    }


@app.get("/api/settings/security/network-users", response_model=list[UserOut])
def settings_security_network_users(
    query: str = "",
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    network_ids = _network_user_ids(current_user.id, db)
    if not network_ids:
        return []
    base = select(User).options(joinedload(User.profile_photo)).where(User.id.in_(network_ids))
    q = query.strip().lower()
    if q:
        base = base.where((User.username.ilike(f"%{q}%")) | (User.full_name.ilike(f"%{q}%")))
    rows = list(db.execute(base.order_by(User.username.asc()).limit(300)).scalars().all())
    return [_build_user_out(row, db, current_user.id) for row in rows]


@app.post("/api/settings/security/message-seen")
def settings_update_message_seen(
    enabled: str = Form("1"),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    setting = _get_or_create_privacy_setting(current_user.id, db)
    value = str(enabled).strip().lower() in {"1", "true", "yes", "on"}
    setting.show_message_seen = value
    setting.updated_at = datetime.utcnow()
    db.commit()
    return {"detail": "Message seen privacy updated.", "show_message_seen": value}


@app.post("/api/settings/security/story-visibility")
def settings_update_story_visibility(
    target_user_ids: str = Form(""),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    ids = _parse_target_user_ids(target_user_ids)
    network_ids = _network_user_ids(current_user.id, db)
    allowed_ids = {user_id for user_id in ids if user_id in network_ids and user_id != current_user.id}

    existing = (
        db.execute(
            select(UserVisibilityRule).where(
                UserVisibilityRule.owner_id == current_user.id,
                UserVisibilityRule.rule_type == "story",
            )
        )
        .scalars()
        .all()
    )
    existing_by_target = {row.target_user_id: row for row in existing}
    for target_id, row in existing_by_target.items():
        if target_id not in allowed_ids:
            db.delete(row)
    for target_id in allowed_ids:
        if target_id not in existing_by_target:
            db.add(UserVisibilityRule(owner_id=current_user.id, target_user_id=target_id, rule_type="story"))
    db.commit()
    return {"detail": "Story visibility updated.", "hidden_story_user_ids": sorted(allowed_ids)}


@app.post("/api/settings/security/profile-visibility")
def settings_update_profile_visibility(
    target_user_ids: str = Form(""),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    ids = _parse_target_user_ids(target_user_ids)
    network_ids = _network_user_ids(current_user.id, db)
    allowed_ids = {user_id for user_id in ids if user_id in network_ids and user_id != current_user.id}

    existing = (
        db.execute(
            select(UserVisibilityRule).where(
                UserVisibilityRule.owner_id == current_user.id,
                UserVisibilityRule.rule_type == "profile",
            )
        )
        .scalars()
        .all()
    )
    existing_by_target = {row.target_user_id: row for row in existing}
    for target_id, row in existing_by_target.items():
        if target_id not in allowed_ids:
            db.delete(row)
    for target_id in allowed_ids:
        if target_id not in existing_by_target:
            db.add(UserVisibilityRule(owner_id=current_user.id, target_user_id=target_id, rule_type="profile"))
    db.commit()
    return {"detail": "Profile visibility updated.", "hidden_profile_user_ids": sorted(allowed_ids)}


@app.post("/api/settings/security/block-user")
def settings_block_user(
    target_user_id: int = Form(...),
    blocked: str = Form("1"),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    if target_user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot block yourself")
    network_ids = _network_user_ids(current_user.id, db)
    if target_user_id not in network_ids:
        raise HTTPException(status_code=400, detail="You can block only users from your followers/following list")
    target = db.execute(select(User.id).where(User.id == target_user_id)).scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")
    should_block = str(blocked).strip().lower() in {"1", "true", "yes", "on"}
    row = (
        db.execute(
            select(UserBlock).where(
                UserBlock.blocker_id == current_user.id,
                UserBlock.blocked_user_id == target_user_id,
            )
        )
        .scalars()
        .first()
    )
    if should_block and not row:
        db.add(UserBlock(blocker_id=current_user.id, blocked_user_id=target_user_id))
    if (not should_block) and row:
        db.delete(row)
    db.commit()
    return {"detail": ("User blocked." if should_block else "User unblocked."), "blocked": should_block}


def _send_security_otp_for_action(action: str, current_user: User, db: Session, subject: str, content: str):
    email = (current_user.email or "").strip().lower()
    if not _is_valid_email(email):
        raise HTTPException(status_code=400, detail="Your account email is invalid.")
    latest = (
        db.execute(
            select(SecurityActionOTP)
            .where(SecurityActionOTP.user_id == current_user.id, SecurityActionOTP.action == action)
            .order_by(desc(SecurityActionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    now = datetime.utcnow()
    if latest:
        diff = (now - latest.created_at).total_seconds()
        if diff < OTP_COOLDOWN_SECONDS:
            wait = int(OTP_COOLDOWN_SECONDS - diff)
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP")
    otp = f"{secrets.randbelow(1000000):06d}"
    db.add(
        SecurityActionOTP(
            user_id=current_user.id,
            email=email,
            action=action,
            otp_hash=_hash_text(otp),
            pending_value="",
            is_verified=False,
            is_used=False,
            expires_at=now + timedelta(minutes=OTP_EXPIRY_MINUTES),
        )
    )
    delivered, mail_status = _send_otp_email(email, otp, subject=subject, content=content.format(otp=otp))
    if delivered:
        db.commit()
        return {"detail": "OTP sent to your registered email."}
    if APP_ENV == "development":
        db.commit()
        return {"detail": f"Email delivery failed ({mail_status}). Using dev OTP.", "dev_otp": otp}
    db.rollback()
    raise HTTPException(status_code=500, detail=mail_status)


def _verify_security_otp_for_action(action: str, otp: str, current_user: User, db: Session):
    otp_clean = otp.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit OTP")
    row = (
        db.execute(
            select(SecurityActionOTP)
            .where(
                SecurityActionOTP.user_id == current_user.id,
                SecurityActionOTP.action == action,
                SecurityActionOTP.is_used.is_(False),
            )
            .order_by(desc(SecurityActionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=400, detail="OTP not found. Request a new one.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired. Request a new one.")
    if row.otp_hash != _hash_text(otp_clean):
        raise HTTPException(status_code=400, detail="Invalid OTP")
    row.is_verified = True
    db.commit()
    return row


@app.post("/api/settings/security/password/send-otp")
def settings_send_password_change_otp(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    return _send_security_otp_for_action(
        action="password_change",
        current_user=current_user,
        db=db,
        subject="StepNix password change verification OTP",
        content="Your OTP to change account password is {otp}. It expires in 10 minutes.",
    )


@app.post("/api/settings/security/password/verify-otp")
def settings_verify_password_change_otp(
    otp: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    _verify_security_otp_for_action("password_change", otp, current_user, db)
    return {"detail": "OTP verified. Enter new password."}


@app.post("/api/settings/security/password/confirm")
def settings_confirm_password_change(
    new_password: str = Form(...),
    confirm_password: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if new_password != confirm_password:
        raise HTTPException(status_code=400, detail="Passwords do not match")
    row = (
        db.execute(
            select(SecurityActionOTP)
            .where(
                SecurityActionOTP.user_id == current_user.id,
                SecurityActionOTP.action == "password_change",
                SecurityActionOTP.is_used.is_(False),
            )
            .order_by(desc(SecurityActionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row or not row.is_verified:
        raise HTTPException(status_code=400, detail="Verify OTP first.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired. Request a new one.")
    row.is_used = True
    current_user.password_hash = _hash_password(new_password)
    db.commit()
    _send_otp_email(
        (current_user.email or "").strip().lower(),
        "000000",
        subject="StepNix password updated",
        content="Your StepNix account password was changed successfully.",
    )
    return {"detail": "Password changed successfully."}


@app.post("/api/settings/security/email/send-otp")
def settings_send_email_change_otp(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    return _send_security_otp_for_action(
        action="email_change",
        current_user=current_user,
        db=db,
        subject="StepNix email update verification OTP",
        content="Your OTP to update account email is {otp}. It expires in 10 minutes.",
    )


@app.post("/api/settings/security/email/verify-otp")
def settings_verify_email_change_otp(
    otp: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    _verify_security_otp_for_action("email_change", otp, current_user, db)
    return {"detail": "OTP verified. Enter new email."}


@app.post("/api/settings/security/email/confirm")
def settings_confirm_email_change(
    new_email: str = Form(...),
    confirm_email: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    next_email = (new_email or "").strip().lower()
    confirm_next = (confirm_email or "").strip().lower()
    if not _is_valid_email(next_email):
        raise HTTPException(status_code=400, detail="Enter valid new email")
    if next_email != confirm_next:
        raise HTTPException(status_code=400, detail="Emails do not match")
    if next_email == (current_user.email or "").strip().lower():
        raise HTTPException(status_code=400, detail="New email must be different from current email")
    existing = db.execute(select(User.id).where(User.email == next_email, User.id != current_user.id)).scalars().first()
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")
    row = (
        db.execute(
            select(SecurityActionOTP)
            .where(
                SecurityActionOTP.user_id == current_user.id,
                SecurityActionOTP.action == "email_change",
                SecurityActionOTP.is_used.is_(False),
            )
            .order_by(desc(SecurityActionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row or not row.is_verified:
        raise HTTPException(status_code=400, detail="Verify OTP first.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired. Request a new one.")
    previous_email = (current_user.email or "").strip().lower()
    row.is_used = True
    current_user.email = next_email
    db.commit()
    _send_otp_email(next_email, "000000", subject="StepNix email updated", content="Your StepNix email was updated successfully.")
    if previous_email and previous_email != next_email:
        _send_otp_email(
            previous_email,
            "000000",
            subject="StepNix account email changed",
            content=f"Your account email has been changed to {next_email}.",
        )
    return {"detail": "Email updated successfully.", "email": next_email}


@app.post("/api/settings/account/delete/send-initial-otp")
def settings_send_delete_initial_otp(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    email = (current_user.email or "").strip().lower()
    if not _is_valid_email(email):
        raise HTTPException(status_code=400, detail="Your account email is invalid. Update account email first.")

    now = datetime.utcnow()
    latest = (
        db.execute(
            select(AccountDeletionOTP)
            .where(
                AccountDeletionOTP.user_id == current_user.id,
                AccountDeletionOTP.stage == "initial",
            )
            .order_by(desc(AccountDeletionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if latest:
        diff = (now - latest.created_at).total_seconds()
        if diff < OTP_COOLDOWN_SECONDS:
            wait = int(OTP_COOLDOWN_SECONDS - diff)
            raise HTTPException(status_code=429, detail=f"Please wait {wait}s before requesting another OTP")

    otp = f"{secrets.randbelow(1000000):06d}"
    db.add(
        AccountDeletionOTP(
            user_id=current_user.id,
            email=email,
            otp_hash=_hash_text(otp),
            stage="initial",
            reason="",
            is_verified=False,
            is_used=False,
            expires_at=now + timedelta(minutes=OTP_EXPIRY_MINUTES),
        )
    )
    delivered, mail_status = _send_otp_email(
        email,
        otp,
        subject="StepNix account deletion verification OTP",
        content=f"Your StepNix account deletion OTP is {otp}. It expires in {OTP_EXPIRY_MINUTES} minutes.",
    )
    if delivered:
        db.commit()
        return {"detail": "OTP sent to your registered email."}
    if APP_ENV == "development":
        db.commit()
        return {"detail": f"Email delivery failed ({mail_status}). Using dev OTP.", "dev_otp": otp}
    db.rollback()
    raise HTTPException(status_code=500, detail=mail_status)


@app.post("/api/settings/account/delete/verify-initial")
def settings_verify_delete_initial_otp(
    otp: str = Form(...),
    reason: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    email = (current_user.email or "").strip().lower()
    if not _is_valid_email(email):
        raise HTTPException(status_code=400, detail="Your account email is invalid. Update account email first.")
    otp_clean = otp.strip()
    reason_clean = reason.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit OTP")
    if len(reason_clean) < 5:
        raise HTTPException(status_code=400, detail="Please enter a reason (at least 5 characters).")

    initial_row = (
        db.execute(
            select(AccountDeletionOTP)
            .where(
                AccountDeletionOTP.user_id == current_user.id,
                AccountDeletionOTP.stage == "initial",
                AccountDeletionOTP.is_used.is_(False),
            )
            .order_by(desc(AccountDeletionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not initial_row:
        raise HTTPException(status_code=400, detail="OTP not found. Request a new one.")
    if initial_row.expires_at < datetime.utcnow():
        db.delete(initial_row)
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired. Request a new one.")
    if initial_row.otp_hash != _hash_text(otp_clean):
        raise HTTPException(status_code=400, detail="Invalid OTP")

    initial_row.is_used = True
    initial_row.is_verified = True
    initial_row.reason = reason_clean

    confirm_otp = f"{secrets.randbelow(1000000):06d}"
    db.add(
        AccountDeletionOTP(
            user_id=current_user.id,
            email=email,
            otp_hash=_hash_text(confirm_otp),
            stage="confirm",
            reason=reason_clean,
            is_verified=False,
            is_used=False,
            expires_at=datetime.utcnow() + timedelta(minutes=OTP_EXPIRY_MINUTES),
        )
    )
    delivered, mail_status = _send_otp_email(
        email,
        confirm_otp,
        subject="StepNix account deletion reconfirmation OTP",
        content=f"Reconfirm account deletion with OTP {confirm_otp}. It expires in {OTP_EXPIRY_MINUTES} minutes.",
    )
    if delivered:
        db.commit()
        return {"detail": "Reconfirmation OTP sent. Enter it to continue."}
    if APP_ENV == "development":
        db.commit()
        return {
            "detail": f"Email delivery failed ({mail_status}). Using dev reconfirmation OTP.",
            "dev_otp": confirm_otp,
        }
    db.rollback()
    raise HTTPException(status_code=500, detail=mail_status)


@app.post("/api/settings/account/delete/verify-confirm")
def settings_verify_delete_confirm_otp(
    otp: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    otp_clean = otp.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit OTP")
    row = (
        db.execute(
            select(AccountDeletionOTP)
            .where(
                AccountDeletionOTP.user_id == current_user.id,
                AccountDeletionOTP.stage == "confirm",
                AccountDeletionOTP.is_used.is_(False),
            )
            .order_by(desc(AccountDeletionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=400, detail="Reconfirmation OTP not found. Start again.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="Reconfirmation OTP expired. Start again.")
    if row.otp_hash != _hash_text(otp_clean):
        raise HTTPException(status_code=400, detail="Invalid OTP")
    row.is_verified = True
    db.commit()
    return {"detail": "OTP verified. You can permanently delete account now."}


@app.post("/api/settings/account/delete/confirm")
def settings_confirm_account_delete(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    row = (
        db.execute(
            select(AccountDeletionOTP)
            .where(
                AccountDeletionOTP.user_id == current_user.id,
                AccountDeletionOTP.stage == "confirm",
                AccountDeletionOTP.is_used.is_(False),
            )
            .order_by(desc(AccountDeletionOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row or not row.is_verified:
        raise HTTPException(status_code=400, detail="Verify reconfirmation OTP first.")
    if row.expires_at < datetime.utcnow():
        db.delete(row)
        db.commit()
        raise HTTPException(status_code=400, detail="Reconfirmation OTP expired. Start again.")

    row.is_used = True
    user = db.execute(select(User).where(User.id == current_user.id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="Account not found")
    db.delete(user)
    db.commit()
    return {"detail": "Account deleted permanently."}


@app.get("/api/chat/auth/status", response_model=ChatAuthStatusOut)
def chat_auth_status(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    session = (
        db.execute(select(ChatDeviceSession).where(ChatDeviceSession.user_id == current_user.id))
        .scalars()
        .first()
    )
    return ChatAuthStatusOut(registered_email=(current_user.email or "").strip().lower(), chat_enabled=session is not None)


@app.post("/api/chat/auth/send-otp")
def chat_send_email_otp(
    email: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    registered_email = (current_user.email or "").strip().lower()
    if not registered_email:
        raise HTTPException(status_code=400, detail="Your account has no registered email.")
    email_clean = email.strip().lower()
    if not email_clean:
        raise HTTPException(status_code=400, detail="Enter your registered email.")
    if email_clean != registered_email:
        raise HTTPException(status_code=400, detail="Enter the same email registered on your account.")

    now = datetime.utcnow()
    recent = (
        db.execute(
            select(ChatEmailOTP)
            .where(ChatEmailOTP.user_id == current_user.id)
            .order_by(desc(ChatEmailOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if recent and (now - recent.created_at).total_seconds() < 30:
        raise HTTPException(status_code=429, detail="Please wait 30 seconds before requesting another OTP.")

    otp = f"{secrets.randbelow(1000000):06d}"
    secret_code = _generate_chat_secret_code(8)
    expires = now + timedelta(minutes=CHAT_OTP_EXPIRY_MINUTES)
    db.add(
        ChatEmailOTP(
            user_id=current_user.id,
            email=email_clean,
            otp_hash=_hash_text(otp),
            secret_code_hash=_hash_text(secret_code),
            expires_at=expires,
            is_used=False,
        )
    )
    db.commit()

    delivered, detail = _send_chat_auth_email(email_clean, otp, secret_code)
    if not delivered:
        raise HTTPException(status_code=500, detail=detail)
    return {"detail": f"OTP and secret code sent to {email_clean}. They expire in 5 minutes."}


@app.post("/api/chat/auth/verify-otp", response_model=ChatAuthOut)
def chat_verify_email_otp(
    email: str = Form(...),
    otp: str = Form(...),
    secret_code: str = Form(...),
    device_id: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    registered_email = (current_user.email or "").strip().lower()
    if not registered_email:
        raise HTTPException(status_code=400, detail="Your account has no registered email.")
    email_clean = email.strip().lower()
    if email_clean != registered_email:
        raise HTTPException(status_code=400, detail="Enter the same email registered on your account.")

    otp_clean = otp.strip()
    secret_clean = secret_code.strip()
    if not re.fullmatch(r"\d{6}", otp_clean):
        raise HTTPException(status_code=400, detail="Enter valid 6-digit OTP")
    if len(secret_clean) != 8:
        raise HTTPException(status_code=400, detail="Enter valid 8-character secret code")
    device = device_id.strip()
    if len(device) < 8:
        raise HTTPException(status_code=400, detail="Invalid device")

    row = (
        db.execute(
            select(ChatEmailOTP)
            .where(
                ChatEmailOTP.user_id == current_user.id,
                ChatEmailOTP.email == email_clean,
                ChatEmailOTP.is_used.is_(False),
            )
            .order_by(desc(ChatEmailOTP.created_at))
            .limit(1)
        )
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=400, detail="OTP not found. Request a new OTP.")
    if row.expires_at < datetime.utcnow():
        row.is_used = True
        db.commit()
        raise HTTPException(status_code=400, detail="OTP expired. Request a new OTP.")
    if _hash_text(otp_clean) != row.otp_hash:
        raise HTTPException(status_code=400, detail="Invalid OTP")
    if _hash_text(secret_clean) != row.secret_code_hash:
        raise HTTPException(status_code=400, detail="Invalid secret code")

    row.is_used = True

    # Single-device login: one active chat session per user.
    session = (
        db.execute(select(ChatDeviceSession).where(ChatDeviceSession.user_id == current_user.id))
        .scalars()
        .first()
    )
    token = secrets.token_urlsafe(36)
    now = datetime.utcnow()
    if session:
        session.device_id = device
        session.session_token = token
        session.last_active_at = now
    else:
        db.add(
            ChatDeviceSession(
                user_id=current_user.id,
                device_id=device,
                session_token=token,
                created_at=now,
                last_active_at=now,
            )
        )
    db.commit()
    return ChatAuthOut(session_token=token, email=email_clean, expires_in_seconds=300)


@app.post("/api/chat/auth/logout")
def chat_logout(
    current_user: User = Depends(_require_user),
    x_chat_token: str | None = Header(default=None),
    db: Session = Depends(get_db),
):
    if not x_chat_token:
        return {"detail": "Chat logged out"}
    row = (
        db.execute(
            select(ChatDeviceSession).where(
                ChatDeviceSession.user_id == current_user.id,
                ChatDeviceSession.session_token == x_chat_token.strip(),
            )
        )
        .scalars()
        .first()
    )
    if row:
        db.delete(row)
        db.commit()
    return {"detail": "Chat logged out"}


@app.get("/api/chat/users", response_model=list[UserOut])
def chat_users(
    query: str = "",
    current_user: User = Depends(_require_chat_session),
    db: Session = Depends(get_db),
):
    base = select(User).options(joinedload(User.profile_photo)).where(User.id != current_user.id)
    q = query.strip().lower()
    if q:
        base = base.where((User.username.ilike(f"%{q}%")) | (User.full_name.ilike(f"%{q}%")))
    rows = db.execute(base.order_by(User.username.asc()).limit(120)).scalars().all()
    visible_rows = [row for row in rows if not _is_blocked_between(current_user.id, row.id, db)]
    return [_build_user_out(row, db, current_user.id) for row in visible_rows]


@app.get("/api/chat/share-recipients", response_model=list[UserOut])
def chat_share_recipients(
    query: str = "",
    current_user: User = Depends(_require_chat_session),
    db: Session = Depends(get_db),
):
    links = (
        db.execute(
            select(UserFollow).where(
                (UserFollow.follower_id == current_user.id) | (UserFollow.following_id == current_user.id)
            )
        )
        .scalars()
        .all()
    )
    network_ids: set[int] = set()
    for link in links:
        if link.follower_id == current_user.id:
            network_ids.add(link.following_id)
        else:
            network_ids.add(link.follower_id)
    if not network_ids:
        return []
    network_ids = {uid for uid in network_ids if not _is_blocked_between(current_user.id, uid, db)}
    if not network_ids:
        return []

    base = select(User).options(joinedload(User.profile_photo)).where(User.id.in_(network_ids))
    q = query.strip().lower()
    if q:
        base = base.where((User.username.ilike(f"%{q}%")) | (User.full_name.ilike(f"%{q}%")))
    users = list(db.execute(base.limit(200)).scalars().all())
    if not users:
        return []

    recent_rows = (
        db.execute(
            select(ChatMessage)
            .where(
                ((ChatMessage.sender_id == current_user.id) & (ChatMessage.receiver_id.in_(network_ids)))
                | ((ChatMessage.receiver_id == current_user.id) & (ChatMessage.sender_id.in_(network_ids)))
            )
            .order_by(desc(ChatMessage.created_at))
            .limit(2000)
        )
        .scalars()
        .all()
    )
    latest_by_partner: dict[int, datetime] = {}
    for row in recent_rows:
        partner_id = row.receiver_id if row.sender_id == current_user.id else row.sender_id
        if partner_id in network_ids and partner_id not in latest_by_partner:
            latest_by_partner[partner_id] = row.created_at

    users.sort(
        key=lambda user: (
            0 if user.id in latest_by_partner else 1,
            -(latest_by_partner[user.id].timestamp()) if user.id in latest_by_partner else 0,
            (user.username or "").lower(),
        )
    )
    return [_build_user_out(user, db, current_user.id) for user in users]


@app.get("/api/chat/active-users", response_model=list[UserOut])
def chat_active_users(current_user: User = Depends(_require_chat_session), db: Session = Depends(get_db)):
    cutoff = datetime.utcnow() - timedelta(seconds=60)
    links = (
        db.execute(
            select(UserFollow).where(
                (UserFollow.follower_id == current_user.id) | (UserFollow.following_id == current_user.id)
            )
        )
        .scalars()
        .all()
    )
    network_ids: set[int] = set()
    for link in links:
        if link.follower_id == current_user.id:
            network_ids.add(link.following_id)
        else:
            network_ids.add(link.follower_id)
    if not network_ids:
        return []
    network_ids = {uid for uid in network_ids if not _is_blocked_between(current_user.id, uid, db)}
    if not network_ids:
        return []

    sessions = (
        db.execute(
            select(ChatDeviceSession)
            .where(ChatDeviceSession.user_id.in_(network_ids))
            .order_by(desc(ChatDeviceSession.last_active_at))
            .limit(80)
        )
        .scalars()
        .all()
    )
    active_ids: list[int] = []
    inactive_ids: list[int] = []
    active_set: set[int] = set()
    seen: set[int] = set()
    for session in sessions:
        uid = session.user_id
        if uid in seen:
            continue
        seen.add(uid)
        if session.last_active_at >= cutoff:
            active_ids.append(uid)
            active_set.add(uid)
        else:
            inactive_ids.append(uid)
    for uid in network_ids:
        if uid not in seen:
            inactive_ids.append(uid)
            seen.add(uid)
    ordered_ids = active_ids + inactive_ids

    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {u.id: u for u in users}
    ordered = [by_id[uid] for uid in ordered_ids if uid in by_id]

    output: list[UserOut] = []
    for user in ordered:
        base = _build_user_out(user, db, current_user.id)
        output.append(base.model_copy(update={"is_active": user.id in active_set}))
    return output


@app.get("/api/chat/conversations", response_model=list[ChatConversationOut])
def chat_conversations(current_user: User = Depends(_require_chat_session), db: Session = Depends(get_db)):
    messages = (
        db.execute(
            select(ChatMessage)
            .where((ChatMessage.sender_id == current_user.id) | (ChatMessage.receiver_id == current_user.id))
            .order_by(desc(ChatMessage.created_at))
        )
        .scalars()
        .all()
    )
    by_partner: dict[int, ChatMessage] = {}
    for msg in messages:
        if _is_chat_message_hidden_for_user(msg, current_user.id):
            continue
        partner_id = msg.receiver_id if msg.sender_id == current_user.id else msg.sender_id
        if _is_blocked_between(current_user.id, partner_id, db):
            continue
        if partner_id not in by_partner:
            by_partner[partner_id] = msg

    output: list[ChatConversationOut] = []
    for partner_id, last_msg in by_partner.items():
        partner = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == partner_id)).scalars().first()
        if not partner:
            continue
        output.append(
            ChatConversationOut(
                user=_build_user_out(partner, db, current_user.id),
                last_message=("This message was deleted" if last_msg.deleted_for_everyone else last_msg.content),
                last_message_at=last_msg.created_at,
            )
        )
    output.sort(key=lambda item: item.last_message_at, reverse=True)
    return output


@app.get("/api/chat/messages/{user_id}", response_model=ChatThreadOut)
def chat_thread(user_id: int, current_user: User = Depends(_require_chat_session), db: Session = Depends(get_db)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Invalid chat user")
    with_user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not with_user:
        raise HTTPException(status_code=404, detail="User not found")
    if _is_blocked_between(current_user.id, user_id, db):
        raise HTTPException(status_code=403, detail="You cannot open chat with this user")
    viewer_privacy = _get_or_create_privacy_setting(current_user.id, db)
    unseen_incoming = (
        db.execute(
            select(ChatMessage).where(
                ChatMessage.sender_id == user_id,
                ChatMessage.receiver_id == current_user.id,
                ChatMessage.seen_at.is_(None),
                ChatMessage.deleted_for_receiver.is_(False),
            )
        )
        .scalars()
        .all()
    )
    if unseen_incoming and viewer_privacy.show_message_seen:
        now = datetime.utcnow()
        for msg in unseen_incoming:
            msg.seen_at = now
        db.commit()
    partner_privacy = _get_or_create_privacy_setting(user_id, db)

    rows = (
        db.execute(
            select(ChatMessage)
            .where(
                ((ChatMessage.sender_id == current_user.id) & (ChatMessage.receiver_id == user_id))
                | ((ChatMessage.sender_id == user_id) & (ChatMessage.receiver_id == current_user.id))
            )
            .order_by(ChatMessage.created_at.asc())
            .limit(400)
        )
        .scalars()
        .all()
    )
    rows = [row for row in rows if not _is_chat_message_hidden_for_user(row, current_user.id)]
    typing_cutoff = datetime.utcnow() - timedelta(seconds=8)
    partner_is_typing = (
        db.execute(
            select(ChatTypingState).where(
                ChatTypingState.user_id == user_id,
                ChatTypingState.partner_id == current_user.id,
                ChatTypingState.is_typing.is_(True),
                ChatTypingState.updated_at >= typing_cutoff,
            )
        )
        .scalars()
        .first()
        is not None
    )
    messages_out = []
    for row in rows:
        message_out = _build_chat_message_out(row, db, current_user.id)
        if row.sender_id == current_user.id and not partner_privacy.show_message_seen:
            message_out = message_out.model_copy(update={"seen_at": None})
        messages_out.append(message_out)
    return ChatThreadOut(
        with_user=_build_user_out(with_user, db, current_user.id),
        messages=messages_out,
        partner_is_typing=partner_is_typing,
    )


@app.post("/api/chat/messages/{user_id}", response_model=ChatMessageOut)
def send_chat_message(
    user_id: int,
    content: str = Form(...),
    current_user: User = Depends(_require_chat_session),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot message yourself")
    receiver = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not receiver:
        raise HTTPException(status_code=404, detail="User not found")
    if _is_blocked_between(current_user.id, user_id, db):
        raise HTTPException(status_code=403, detail="Message cannot be sent. User is blocked.")
    body = content.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    row = ChatMessage(sender_id=current_user.id, receiver_id=user_id, content=body)
    db.add(row)
    db.flush()
    db.execute(
        text("UPDATE chat_messages SET conversation_id = :conversation_id WHERE id = :message_id"),
        {
            "conversation_id": f"{min(current_user.id, user_id)}:{max(current_user.id, user_id)}",
            "message_id": row.id,
        },
    )
    created_notifications = _create_notifications(
        db=db,
        recipient_ids={user_id},
        actor_id=current_user.id,
        event_type="new_message",
        title=f"@{current_user.username} sent you a message",
        message=_chat_notification_preview(body),
    )
    typing_row = (
        db.execute(
            select(ChatTypingState).where(
                ChatTypingState.user_id == current_user.id,
                ChatTypingState.partner_id == user_id,
            )
        )
        .scalars()
        .first()
    )
    if typing_row:
        typing_row.is_typing = False
        typing_row.updated_at = datetime.utcnow()
    db.commit()
    _publish_notification_rows(created_notifications)
    db.refresh(row)
    return _build_chat_message_out(row, db, current_user.id)


@app.post("/api/chat/messages/{message_id}/delete")
def delete_chat_message(
    message_id: int,
    scope: str = Form("me"),
    current_user: User = Depends(_require_chat_session),
    db: Session = Depends(get_db),
):
    row = db.execute(select(ChatMessage).where(ChatMessage.id == message_id)).scalars().first()
    if not row:
        raise HTTPException(status_code=404, detail="Message not found")
    if current_user.id not in {row.sender_id, row.receiver_id}:
        raise HTTPException(status_code=403, detail="You cannot delete this message")

    mode = scope.strip().lower()
    if mode not in {"me", "everyone"}:
        raise HTTPException(status_code=400, detail="Invalid delete scope")

    now = datetime.utcnow()
    if mode == "everyone":
        if current_user.id != row.sender_id:
            raise HTTPException(status_code=403, detail="Only sender can delete for everyone")
        if row.deleted_for_everyone:
            return {"detail": "Already deleted for everyone", "scope": "everyone"}
        row.deleted_for_everyone = True
        row.deleted_at = now
        db.commit()
        return {"detail": "Message deleted for everyone", "scope": "everyone"}

    if current_user.id == row.sender_id:
        row.deleted_for_sender = True
    else:
        row.deleted_for_receiver = True
    row.deleted_at = now
    db.commit()
    return {"detail": "Message deleted for you", "scope": "me"}


@app.post("/api/chat/typing/{user_id}")
def set_chat_typing(
    user_id: int,
    is_typing: str = Form("1"),
    current_user: User = Depends(_require_chat_session),
    db: Session = Depends(get_db),
):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Invalid chat user")
    partner = db.execute(select(User.id).where(User.id == user_id)).first()
    if not partner:
        raise HTTPException(status_code=404, detail="User not found")
    if _is_blocked_between(current_user.id, user_id, db):
        raise HTTPException(status_code=403, detail="Cannot update typing state for blocked user")

    value = str(is_typing).strip().lower() in {"1", "true", "yes", "on"}
    row = (
        db.execute(
            select(ChatTypingState).where(
                ChatTypingState.user_id == current_user.id,
                ChatTypingState.partner_id == user_id,
            )
        )
        .scalars()
        .first()
    )
    now = datetime.utcnow()
    if not row:
        row = ChatTypingState(
            user_id=current_user.id,
            partner_id=user_id,
            is_typing=value,
            updated_at=now,
        )
        db.add(row)
    else:
        row.is_typing = value
        row.updated_at = now
    db.commit()
    return {"detail": "Typing status updated", "is_typing": value}


@app.get("/api/notifications", response_model=list[NotificationOut])
def list_notifications(
    limit: int = 30,
    after_id: int | None = None,
    unread_only: bool = False,
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    safe_limit = max(1, min(limit, 80))
    if not unread_only and not after_id:
        cached_count = _redis_get(_notification_count_key(current_user.id))
        if cached_count is None:
            unread_count = db.query(Notification).filter(
                Notification.recipient_id == current_user.id,
                Notification.is_read.is_(False),
            ).count()
            _redis_setex(_notification_count_key(current_user.id), 60, str(unread_count))
    query = (
        select(Notification)
        .where(Notification.recipient_id == current_user.id)
        .options(joinedload(Notification.actor).joinedload(User.profile_photo))
    )
    if unread_only:
        query = query.where(Notification.is_read.is_(False))
    if after_id and after_id > 0:
        rows = (
            db.execute(query.where(Notification.id > after_id).order_by(Notification.id.asc()).limit(safe_limit))
            .scalars()
            .all()
        )
        return [_build_notification_out(row) for row in rows]

    rows = db.execute(query.order_by(desc(Notification.created_at)).limit(safe_limit)).scalars().all()
    return [_build_notification_out(row) for row in rows]


@app.post("/api/notifications/{notification_id}/read")
def mark_notification_read(
    notification_id: int,
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    row = (
        db.execute(
            select(Notification).where(
                Notification.id == notification_id,
                Notification.recipient_id == current_user.id,
            )
        )
        .scalars()
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail="Notification not found")
    row.is_read = True
    db.commit()
    _invalidate_notification_counts(current_user.id)
    return {"detail": "Notification marked as read"}


@app.post("/api/notifications/read-all")
def mark_all_notifications_read(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    rows = (
        db.execute(
            select(Notification).where(
                Notification.recipient_id == current_user.id,
                Notification.is_read.is_(False),
            )
        )
        .scalars()
        .all()
    )
    for row in rows:
        row.is_read = True
    db.commit()
    _invalidate_notification_counts(current_user.id)
    return {"detail": "All notifications marked as read", "updated": len(rows)}


@app.websocket("/ws/notifications")
async def notifications_websocket(websocket: WebSocket):
    token_value = (websocket.query_params.get("token") or "").strip()
    if not token_value:
        await websocket.close(code=4401)
        return

    with Session(engine) as db:
        user = _user_from_token_value(token_value, db)
    if not user:
        await websocket.close(code=4401)
        return

    await notification_hub.connect(user.id, websocket)
    pubsub = None
    relay_task: asyncio.Task[Any] | None = None
    client = _get_redis_client()
    if client is not None:
        with suppress(Exception):
            pubsub = client.pubsub()
            pubsub.subscribe(f"notifications:{user.id}")
            relay_task = asyncio.create_task(_relay_notification_pubsub(websocket, pubsub))
    try:
        await websocket.send_json({"type": "ready"})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        await notification_hub.disconnect(user.id, websocket)
    except Exception:
        await notification_hub.disconnect(user.id, websocket)
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        if relay_task:
            relay_task.cancel()
            with suppress(Exception):
                await relay_task
        if pubsub is not None:
            with suppress(Exception):
                pubsub.unsubscribe(f"notifications:{user.id}")
            with suppress(Exception):
                pubsub.close()


async def _relay_notification_pubsub(websocket: WebSocket, pubsub: Any) -> None:
    while True:
        message = await asyncio.to_thread(pubsub.get_message, True, 1.0)
        if not message or message.get("type") != "message":
            await asyncio.sleep(0.1)
            continue
        data = message.get("data")
        if not data:
            continue
        try:
            payload = json.loads(data)
        except Exception:
            continue
        try:
            await websocket.send_json(payload)
        except Exception:
            return


@app.get("/api/users", response_model=list[UserOut])
def list_users(db: Session = Depends(get_db)):
    users = db.execute(select(User).options(joinedload(User.profile_photo)).order_by(User.username.asc())).scalars().all()
    return [_build_user_out(user, db) for user in users]


@app.get("/api/users/{user_id}", response_model=UserOut)
def get_user(user_id: int, db: Session = Depends(get_db)):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return _build_user_out(user, db)


@app.post("/api/users/{user_id}/follow", response_model=UserOut)
def follow_user(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot follow yourself")

    target = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    existing = (
        db.execute(
            select(UserFollow).where(
                UserFollow.follower_id == current_user.id,
                UserFollow.following_id == user_id,
            )
        )
        .scalars()
        .first()
    )
    created_notifications: list[Notification] = []
    if not existing:
        db.add(UserFollow(follower_id=current_user.id, following_id=user_id))
        created_notifications = _create_notifications(
            db=db,
            recipient_ids={user_id},
            actor_id=current_user.id,
            event_type="new_follower",
            title=f"@{current_user.username} started following you",
            message="Your motivation circle just grew.",
        )
        db.commit()
        _publish_notification_rows(created_notifications)
        _bump_feed_cache_version()

    refreshed = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not refreshed:
        raise HTTPException(status_code=500, detail="Failed to load user")
    return _build_user_out(refreshed, db, current_user.id)


@app.delete("/api/users/{user_id}/follow", response_model=UserOut)
def unfollow_user(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot unfollow yourself")

    target = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    existing = (
        db.execute(
            select(UserFollow).where(
                UserFollow.follower_id == current_user.id,
                UserFollow.following_id == user_id,
            )
        )
        .scalars()
        .first()
    )
    if existing:
        db.delete(existing)
        db.commit()
        _bump_feed_cache_version()

    refreshed = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not refreshed:
        raise HTTPException(status_code=500, detail="Failed to load user")
    return _build_user_out(refreshed, db, current_user.id)


@app.get("/api/me/followers", response_model=list[UserOut])
def my_followers(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    links = (
        db.execute(
            select(UserFollow)
            .where(UserFollow.following_id == current_user.id)
            .order_by(desc(UserFollow.created_at))
        )
        .scalars()
        .all()
    )
    if not links:
        return []

    ordered_ids = [link.follower_id for link in links]
    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {user.id: user for user in users}
    return [_build_user_out(by_id[user_id], db, current_user.id) for user_id in ordered_ids if user_id in by_id]


@app.get("/api/me/following", response_model=list[UserOut])
def my_following(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    links = (
        db.execute(
            select(UserFollow)
            .where(UserFollow.follower_id == current_user.id)
            .order_by(desc(UserFollow.created_at))
        )
        .scalars()
        .all()
    )
    if not links:
        return []

    ordered_ids = [link.following_id for link in links]
    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {user.id: user for user in users}
    return [_build_user_out(by_id[user_id], db, current_user.id) for user_id in ordered_ids if user_id in by_id]


@app.get("/api/users/{user_id}/followers", response_model=list[UserOut])
def user_followers(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    target = db.execute(select(User).where(User.id == user_id)).scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    links = (
        db.execute(
            select(UserFollow)
            .where(UserFollow.following_id == user_id)
            .order_by(desc(UserFollow.created_at))
        )
        .scalars()
        .all()
    )
    if not links:
        return []

    ordered_ids = [link.follower_id for link in links]
    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {user.id: user for user in users}
    return [_build_user_out(by_id[item_id], db, current_user.id) for item_id in ordered_ids if item_id in by_id]


@app.get("/api/users/{user_id}/following", response_model=list[UserOut])
def user_following(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    target = db.execute(select(User).where(User.id == user_id)).scalars().first()
    if not target:
        raise HTTPException(status_code=404, detail="User not found")

    links = (
        db.execute(
            select(UserFollow)
            .where(UserFollow.follower_id == user_id)
            .order_by(desc(UserFollow.created_at))
        )
        .scalars()
        .all()
    )
    if not links:
        return []

    ordered_ids = [link.following_id for link in links]
    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {user.id: user for user in users}
    return [_build_user_out(by_id[item_id], db, current_user.id) for item_id in ordered_ids if item_id in by_id]


@app.post("/api/me/photo", response_model=UserOut)
def update_my_profile_photo(
    profile_photo: UploadFile = File(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == current_user.id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    photo_path = _save_image(profile_photo)
    if user.profile_photo:
        user.profile_photo.image_path = photo_path
    else:
        db.add(UserProfilePhoto(user_id=user.id, image_path=photo_path))
    db.commit()

    refreshed = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user.id)).scalars().first()
    if not refreshed:
        raise HTTPException(status_code=500, detail="Failed to load user")
    return _build_user_out(refreshed, db, current_user.id)


@app.post("/api/me/bio", response_model=UserOut)
def update_my_bio(
    bio: str = Form(""),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == current_user.id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    raw_bio = bio if isinstance(bio, str) else ""
    if len(raw_bio) > 250:
        raise HTTPException(status_code=400, detail="Bio cannot exceed 250 characters")

    user.bio = raw_bio
    db.commit()
    db.refresh(user)
    return _build_user_out(user, db, current_user.id)


@app.post("/api/me/profile/update", response_model=UserOut)
def update_my_profile_details(
    username: str = Form(...),
    full_name: str = Form(...),
    gender: str = Form("prefer_not_to_say"),
    bio: str = Form(""),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == current_user.id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    username_clean = (username or "").strip().lower()
    full_name_clean = (full_name or "").strip()
    gender_clean = (gender or "").strip().lower()
    bio_clean = bio if isinstance(bio, str) else ""

    if not re.fullmatch(r"[a-z0-9_]{3,40}", username_clean):
        raise HTTPException(status_code=400, detail="Username must be 3-40 chars: lowercase letters, numbers, underscore")
    if len(full_name_clean) < 2 or len(full_name_clean) > 120:
        raise HTTPException(status_code=400, detail="Name must be between 2 and 120 characters")
    if gender_clean not in ALLOWED_GENDERS:
        raise HTTPException(status_code=400, detail="Select a valid gender")
    if len(bio_clean) > 250:
        raise HTTPException(status_code=400, detail="Bio cannot exceed 250 characters")

    username_taken = (
        db.execute(select(User.id).where(User.username == username_clean, User.id != user.id)).scalars().first()
    )
    if username_taken:
        raise HTTPException(status_code=400, detail="Username already exists")

    user.username = username_clean
    user.full_name = full_name_clean
    user.gender = gender_clean
    user.bio = bio_clean
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=400, detail="Username already exists")
    db.refresh(user)
    return _build_user_out(user, db, current_user.id)


@app.post("/api/posts", response_model=PostOut)
def create_post(
    goal_title: str = Form(...),
    caption: str = Form(""),
    day_experience: str = Form(""),
    timezone_offset_minutes: int = Form(0),
    screenshots: list[UploadFile] = File(default=[]),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    goal_title_clean = goal_title.strip()
    caption_clean = caption.strip()
    day_experience_clean = day_experience.strip()
    now_utc = datetime.utcnow().replace(microsecond=0)
    new_streak_count, streak_just_increased = _resolve_streak_for_local_post(
        current_user,
        timezone_offset_minutes=timezone_offset_minutes,
        now_utc=now_utc,
    )
    current_user.current_streak = new_streak_count
    current_user.last_post_date = now_utc
    post = Post(
        author_id=current_user.id,
        goal_title=goal_title_clean,
        caption=caption_clean,
        day_experience=day_experience_clean,
    )
    db.add(post)
    db.flush()

    for file in screenshots:
        if not file.filename:
            continue
        media_path = _save_post_media(file)
        db.add(PostImage(post_id=post.id, image_path=media_path))

    follower_ids = set(
        db.execute(select(UserFollow.follower_id).where(UserFollow.following_id == current_user.id)).scalars().all()
    )
    mention_text = "\n".join(part for part in [caption_clean, day_experience_clean] if part)
    mentioned_ids = _mentioned_user_ids(mention_text, db=db, exclude_ids={current_user.id})
    created_notifications = _create_notifications(
        db=db,
        recipient_ids=follower_ids - mentioned_ids,
        actor_id=current_user.id,
        event_type="new_progress",
        title=f"@{current_user.username} posted new daily progress",
        message=goal_title_clean[:140],
        post_id=post.id,
    )
    created_notifications.extend(
        _create_notifications(
            db=db,
            recipient_ids=mentioned_ids,
            actor_id=current_user.id,
            event_type="post_mention",
            title=f"@{current_user.username} mentioned you in a progress post",
            message=(mention_text or goal_title_clean)[:160],
            post_id=post.id,
        )
    )

    db.commit()
    _publish_notification_rows(created_notifications)
    _bump_feed_cache_version()

    created = (
        db.execute(
            select(Post)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
                joinedload(Post.likes),
                joinedload(Post.comments),
            )
            .where(Post.id == post.id)
        )
        .unique()
        .scalars()
        .first()
    )
    if not created:
        raise HTTPException(status_code=500, detail="Failed to load post")
    return _build_post_out(
        created,
        db,
        current_user.id,
        new_streak_count=new_streak_count,
        streak_just_increased=streak_just_increased,
    )


@app.delete("/api/posts/{post_id}")
def delete_post(post_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")
    if post.author_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the post owner can delete this post")

    db.delete(post)
    db.commit()
    _bump_feed_cache_version()
    return {"detail": "Post deleted"}


def _network_user_ids(current_user_id: int, db: Session) -> set[int]:
    links = (
        db.execute(
            select(UserFollow).where(
                (UserFollow.follower_id == current_user_id) | (UserFollow.following_id == current_user_id)
            )
        )
        .scalars()
        .all()
    )
    ids: set[int] = set()
    for link in links:
        if link.follower_id == current_user_id:
            ids.add(link.following_id)
        else:
            ids.add(link.follower_id)
    return ids


def _is_blocked_between(user_a_id: int, user_b_id: int, db: Session) -> bool:
    if user_a_id == user_b_id:
        return False
    row = (
        db.execute(
            select(UserBlock).where(
                ((UserBlock.blocker_id == user_a_id) & (UserBlock.blocked_user_id == user_b_id))
                | ((UserBlock.blocker_id == user_b_id) & (UserBlock.blocked_user_id == user_a_id))
            )
        )
        .scalars()
        .first()
    )
    return row is not None


def _is_visibility_hidden(owner_id: int, target_user_id: int, rule_type: str, db: Session) -> bool:
    if owner_id == target_user_id:
        return False
    row = (
        db.execute(
            select(UserVisibilityRule).where(
                UserVisibilityRule.owner_id == owner_id,
                UserVisibilityRule.target_user_id == target_user_id,
                UserVisibilityRule.rule_type == rule_type,
            )
        )
        .scalars()
        .first()
    )
    return row is not None


def _get_or_create_privacy_setting(user_id: int, db: Session) -> UserPrivacySetting:
    row = db.execute(select(UserPrivacySetting).where(UserPrivacySetting.user_id == user_id)).scalars().first()
    if row:
        return row
    row = UserPrivacySetting(user_id=user_id, show_message_seen=True, created_at=datetime.utcnow(), updated_at=datetime.utcnow())
    db.add(row)
    db.flush()
    return row


def _author_interaction_scores(current_user_id: int, db: Session) -> dict[int, float]:
    scores: dict[int, float] = defaultdict(float)

    liked_author_rows = (
        db.execute(
            select(Post.author_id)
            .join(PostLike, PostLike.post_id == Post.id)
            .where(PostLike.user_id == current_user_id)
        )
        .all()
    )
    for (author_id,) in liked_author_rows:
        if author_id and author_id != current_user_id:
            scores[author_id] += 6.0

    commented_author_rows = (
        db.execute(
            select(Post.author_id)
            .join(Comment, Comment.post_id == Post.id)
            .where(Comment.author_id == current_user_id)
        )
        .all()
    )
    for (author_id,) in commented_author_rows:
        if author_id and author_id != current_user_id:
            scores[author_id] += 7.0

    chat_rows = (
        db.execute(
            select(ChatMessage.sender_id, ChatMessage.receiver_id)
            .where((ChatMessage.sender_id == current_user_id) | (ChatMessage.receiver_id == current_user_id))
            .order_by(desc(ChatMessage.created_at))
            .limit(5000)
        )
        .all()
    )
    for sender_id, receiver_id in chat_rows:
        partner_id = receiver_id if sender_id == current_user_id else sender_id
        if partner_id and partner_id != current_user_id:
            scores[partner_id] += 3.0

    followed_rows = (
        db.execute(select(UserFollow.following_id).where(UserFollow.follower_id == current_user_id))
        .all()
    )
    for (following_id,) in followed_rows:
        if following_id and following_id != current_user_id:
            scores[following_id] += 24.0

    return scores


def _build_personalized_suggestions(
    current_user_id: int,
    network_ids: set[int],
    interaction_scores: dict[int, float],
    db: Session,
    limit: int = 18,
) -> list[UserOut]:
    following_ids = {
        row[0]
        for row in db.execute(select(UserFollow.following_id).where(UserFollow.follower_id == current_user_id)).all()
    }
    excluded = {current_user_id, *following_ids}
    if not network_ids:
        return []

    interaction_rank = {
        user_id: idx
        for idx, (user_id, _score) in enumerate(
            sorted(interaction_scores.items(), key=lambda item: item[1], reverse=True)
        )
    }

    score_by_candidate: dict[int, float] = defaultdict(float)
    second_degree_links = (
        db.execute(
            select(UserFollow).where(
                (UserFollow.follower_id.in_(network_ids)) | (UserFollow.following_id.in_(network_ids))
            )
        )
        .scalars()
        .all()
    )
    for link in second_degree_links:
        if link.follower_id in network_ids and link.following_id not in excluded:
            candidate = link.following_id
            source = link.follower_id
            score_by_candidate[candidate] += 2.0
            if source in interaction_rank:
                score_by_candidate[candidate] += max(0.0, 14.0 - interaction_rank[source] * 0.8)
        if link.following_id in network_ids and link.follower_id not in excluded:
            candidate = link.follower_id
            source = link.following_id
            score_by_candidate[candidate] += 2.0
            if source in interaction_rank:
                score_by_candidate[candidate] += max(0.0, 14.0 - interaction_rank[source] * 0.8)

    if not score_by_candidate:
        return []

    candidate_ids = list(score_by_candidate.keys())
    users = list(
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(candidate_ids)))
        .scalars()
        .all()
    )
    users.sort(
        key=lambda user: (
            -score_by_candidate.get(user.id, 0.0),
            (user.username or "").lower(),
        )
    )
    return [_build_user_out(user, db, current_user_id) for user in users[:limit]]


def _post_text_signature(post: Post) -> str:
    parts = [
        post.goal_title or "",
        post.caption or "",
        post.day_experience or "",
        post.author.username if post.author else "",
        post.author.full_name if post.author else "",
    ]
    return " \n".join(parts)


def _hash_embed_text(text: str, dim: int) -> Any:
    if np is None:
        raise RuntimeError("numpy is required for embedding operations")
    np_mod = np
    vec = np_mod.zeros(dim, dtype=np_mod.float32)
    tokens = re.findall(r"[a-z0-9_]+", (text or "").lower())
    if not tokens:
        return vec
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if (digest[4] & 1) else -1.0
        vec[idx] += sign
    norm = float(np_mod.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


def _build_user_query_vector(
    current_user_id: int,
    posts: list[Post],
    interaction_scores: dict[int, float],
    db: Session,
    dim: int,
) -> Any:
    if np is None:
        raise RuntimeError("numpy is required for query vector operations")
    np_mod = np
    liked_ids = {
        row[0]
        for row in db.execute(select(PostLike.post_id).where(PostLike.user_id == current_user_id)).all()
    }
    commented_ids = {
        row[0]
        for row in db.execute(select(Comment.post_id).where(Comment.author_id == current_user_id)).all()
    }

    query_vec = np_mod.zeros(dim, dtype=np_mod.float32)
    total_weight = 0.0
    for post in posts:
        weight = 0.0
        if post.id in liked_ids:
            weight += 4.0
        if post.id in commented_ids:
            weight += 5.0
        weight += min(10.0, interaction_scores.get(post.author_id, 0.0) * 0.12)
        if weight <= 0:
            continue
        emb = _hash_embed_text(_post_text_signature(post), dim)
        if not np_mod.any(emb):
            continue
        query_vec += emb * np_mod.float32(weight)
        total_weight += weight

    if total_weight <= 0:
        return np_mod.zeros(dim, dtype=np_mod.float32)
    query_vec /= np_mod.float32(total_weight)
    norm = float(np_mod.linalg.norm(query_vec))
    if norm > 0:
        query_vec /= norm
    return query_vec.astype(np_mod.float32)


def _rank_posts_faiss_or_hybrid(
    mode: str,
    posts: list[Post],
    current_user_id: int,
    network_ids: set[int],
    interaction_scores: dict[int, float],
    last_seen_at: datetime | None,
    prefer_video: bool,
    db: Session,
) -> tuple[list[Post], str]:
    if mode not in {"faiss", "hybrid"}:
        return posts, "heuristic"
    if np is None:
        return posts, f"{mode}_fallback_no_numpy"
    if faiss is None:
        return posts, f"{mode}_fallback_no_faiss"
    if not posts:
        return posts, mode
    np_mod = np
    faiss_mod = cast(Any, faiss)

    dim = FEED_EMBED_DIM
    vectors = np_mod.stack([_hash_embed_text(_post_text_signature(post), dim) for post in posts], axis=0).astype(np_mod.float32)
    if vectors.shape[0] == 0:
        return posts, f"{mode}_fallback_empty_vectors"

    query_vec = _build_user_query_vector(
        current_user_id=current_user_id,
        posts=posts,
        interaction_scores=interaction_scores,
        db=db,
        dim=dim,
    )
    if not np_mod.any(query_vec):
        return posts, f"{mode}_fallback_cold_start"

    if _persisted_faiss_index is not None and _persisted_faiss_post_ids:
        try:
            persisted_dim = int(_persisted_faiss_index.d)
        except Exception:
            persisted_dim = dim
        if persisted_dim == dim:
            try:
                search_k = min(len(_persisted_faiss_post_ids), max(len(posts), 1))
                scores, ids = _persisted_faiss_index.search(query_vec.reshape(1, -1), search_k)
                available = {post.id: post for post in posts}
                ordered: list[Post] = []
                score_by_post_id: dict[int, float] = {}
                for rank_idx, idx in enumerate(ids[0]):
                    pos = int(idx)
                    if pos < 0 or pos >= len(_persisted_faiss_post_ids):
                        continue
                    post_id = _persisted_faiss_post_ids[pos]
                    post = available.get(post_id)
                    if not post:
                        continue
                    ordered.append(post)
                    score_by_post_id[post.id] = float(scores[0][rank_idx])
                if ordered:
                    ordered_ids = {post.id for post in ordered}
                    remaining = [post for post in posts if post.id not in ordered_ids]
                    ordered.extend(remaining)
                    if mode == "faiss":
                        return ordered, "faiss_persisted"
            except Exception:
                pass

    index = faiss_mod.IndexFlatIP(dim)
    index.add(vectors)
    scores, ids = index.search(query_vec.reshape(1, -1), len(posts))
    post_by_id = {post.id: post for post in posts}
    faiss_order = [post_by_id[posts[int(i)].id] for i in ids[0] if 0 <= int(i) < len(posts)]
    faiss_score_by_post_id = {
        posts[int(i)].id: float(scores[0][rank_idx])
        for rank_idx, i in enumerate(ids[0])
        if 0 <= int(i) < len(posts)
    }

    def rank_key(post: Post) -> tuple[float, ...]:
        is_seen = 1 if (last_seen_at and post.created_at <= last_seen_at) else 0
        group = 0 if interaction_scores.get(post.author_id, 0.0) > 0 else (1 if post.author_id in network_ids else 2)
        faiss_score = faiss_score_by_post_id.get(post.id, 0.0)
        media_bonus = 1.2 if (prefer_video == bool(post.screenshots and _is_video_path(post.screenshots[0].image_path))) else 0.0
        social_bonus = min(8.0, interaction_scores.get(post.author_id, 0.0) * 0.1)
        final_vector_score = faiss_score if mode == "faiss" else (faiss_score * 0.7 + social_bonus * 0.3 + media_bonus * 0.15)
        return (
            float(is_seen),
            float(group),
            -final_vector_score,
            -social_bonus,
            -post.created_at.timestamp(),
            -float(post.id),
        )

    faiss_order.sort(key=rank_key)
    return faiss_order, mode


@app.get("/api/feed", response_model=FeedOut)
def global_feed(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    cached_payload = _redis_get(_feed_cache_key(current_user.id))
    if cached_payload:
        with suppress(Exception):
            return FeedOut.model_validate_json(cached_payload)
    started_at = time.perf_counter()
    now = datetime.utcnow()
    feed_state = (
        db.execute(select(UserFeedState).where(UserFeedState.user_id == current_user.id))
        .scalars()
        .first()
    )
    last_seen_at = feed_state.last_seen_at if feed_state else None

    network_ids = _network_user_ids(current_user.id, db)
    interaction_scores = _author_interaction_scores(current_user.id, db)

    posts = list(
        db.execute(
            select(Post)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
                joinedload(Post.likes),
                joinedload(Post.comments),
            )
            .order_by(desc(Post.created_at))
        )
        .unique()
        .scalars()
        .all()
    )
    posts = [
        post
        for post in posts
        if not _is_blocked_between(current_user.id, post.author_id, db)
    ]

    liked_post_ids = {
        row[0]
        for row in db.execute(select(PostLike.post_id).where(PostLike.user_id == current_user.id)).all()
    }
    liked_video_count = 0
    liked_image_count = 0
    post_media_map: dict[int, bool] = {}
    for post in posts:
        is_video = bool(post.screenshots and _is_video_path(post.screenshots[0].image_path))
        post_media_map[post.id] = is_video
        if post.id in liked_post_ids:
            if is_video:
                liked_video_count += 1
            else:
                liked_image_count += 1
    prefer_video = liked_video_count > liked_image_count

    def rank_key(post: Post) -> tuple[float, ...]:
        is_seen = 1 if (last_seen_at and post.created_at <= last_seen_at) else 0
        author_score = interaction_scores.get(post.author_id, 0.0)
        group = 0 if author_score > 0 else (1 if post.author_id in network_ids else 2)
        media_bonus = 0.0
        if post.id in post_media_map:
            if prefer_video and post_media_map[post.id]:
                media_bonus = 1.2
            elif (not prefer_video) and (not post_media_map[post.id]):
                media_bonus = 1.2
        return (
            float(is_seen),
            float(group),
            -author_score,
            -media_bonus,
            -post.created_at.timestamp(),
            -float(post.id),
        )

    posts.sort(key=rank_key)
    ranked_mode = "heuristic"
    if FEED_RANKER_MODE in {"faiss", "hybrid"}:
        posts, ranked_mode = _rank_posts_faiss_or_hybrid(
            mode=FEED_RANKER_MODE,
            posts=posts,
            current_user_id=current_user.id,
            network_ids=network_ids,
            interaction_scores=interaction_scores,
            last_seen_at=last_seen_at,
            prefer_video=prefer_video,
            db=db,
        )
    suggested_users = _build_personalized_suggestions(
        current_user_id=current_user.id,
        network_ids=network_ids,
        interaction_scores=interaction_scores,
        db=db,
        limit=18,
    )

    if not feed_state:
        db.add(UserFeedState(user_id=current_user.id, last_seen_at=now))
    else:
        feed_state.last_seen_at = now
    db.commit()

    elapsed_ms = int((time.perf_counter() - started_at) * 1000)
    response = FeedOut(
        posts=[_build_post_out(post, db, current_user.id) for post in posts],
        suggested_users=suggested_users,
        ranking_mode=ranked_mode,
        ranking_latency_ms=elapsed_ms,
    )
    _redis_setex(_feed_cache_key(current_user.id), FEED_CACHE_TTL_SECONDS, response.model_dump_json())
    return response


@app.get("/api/posts/{post_id}/preview")
def post_preview(post_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    post = (
        db.execute(
            select(Post)
            .where(Post.id == post_id)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
            )
        )
        .scalars()
        .first()
    )
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    first_media = post.screenshots[0].image_path if post.screenshots else ""
    return {
        "id": post.id,
        "goal_title": post.goal_title,
        "caption": post.caption,
        "author_id": post.author.id,
        "author_username": post.author.username,
        "author_photo_url": _public_media_url(post.author.profile_photo.image_path) if post.author.profile_photo else None,
        "media_url": _public_media_url(first_media) or "",
        "media_type": "video" if _is_video_path(first_media) else ("image" if first_media else "none"),
        "post_url": f"/post/{post.id}",
    }


@app.get("/api/stories/{story_id}/preview")
def story_preview(story_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    story = (
        db.execute(
            select(Story)
            .where(Story.id == story_id)
            .options(
                joinedload(Story.author).joinedload(User.profile_photo),
                joinedload(Story.views),
            )
        )
        .scalars()
        .first()
    )
    if not story:
        raise HTTPException(status_code=404, detail="Story not found")

    return {
        "id": story.id,
        "caption": story.caption,
        "author_id": story.author.id,
        "author_username": story.author.username,
        "author_photo_url": _public_media_url(story.author.profile_photo.image_path) if story.author.profile_photo else None,
        "media_url": _public_media_url(story.media_path) or "",
        "media_type": story.media_type or ("video" if _is_video_path(story.media_path) else "image"),
        "story_url": f"/community-feed?story_user_id={story.author.id}",
        "created_at": story.created_at.isoformat(),
    }


@app.post("/api/stories", response_model=StoryOut)
def create_story(
    story_media: UploadFile = File(...),
    caption: str = Form(""),
    sticker_data: str = Form(""),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    if not story_media.filename:
        raise HTTPException(status_code=400, detail="Story media is required")

    follower_ids = set(
        db.execute(select(UserFollow.follower_id).where(UserFollow.following_id == current_user.id)).scalars().all()
    )
    created_notifications: list[Notification] = []
    ext = os.path.splitext(story_media.filename)[1].lower()
    if ext in ALLOWED_IMAGE_EXT:
        sticker_data_clean = _sanitize_sticker_data(sticker_data)
        _, path = _save_upload_file(story_media, ALLOWED_IMAGE_EXT)
        path = _persist_local_media_path(path, folder="stories")
        story = Story(
            author_id=current_user.id,
            media_path=path,
            media_type="image",
            duration_seconds=5,
            caption=caption.strip(),
            sticker_data=sticker_data_clean,
        )
        db.add(story)
        created_notifications = _create_notifications(
            db=db,
            recipient_ids=follower_ids,
            actor_id=current_user.id,
            event_type="new_story",
            title=f"@{current_user.username} posted a new story",
            message=(caption.strip() or "New 24h story")[:160],
        )
        db.commit()
        _publish_notification_rows(created_notifications)
        _bump_feed_cache_version()
        db.refresh(story)
        return _build_story_out(story, current_user.id)

    if ext in ALLOWED_VIDEO_EXT:
        sticker_data_clean = _sanitize_sticker_data(sticker_data)
        file_name, original_path = _save_upload_file(story_media, ALLOWED_VIDEO_EXT)
        original_abs = UPLOAD_DIR / file_name
        duration = _ffprobe_duration_seconds(original_abs)

        if duration <= 60:
            persisted_path = _persist_local_media_path(original_path, folder="stories")
            row = Story(
                author_id=current_user.id,
                media_path=persisted_path,
                media_type="video",
                duration_seconds=duration,
                caption=caption.strip(),
                sticker_data=sticker_data_clean,
            )
            db.add(row)
        else:
            chunk_paths = _split_video_to_minute_chunks(original_abs, file_name)
            try:
                original_abs.unlink(missing_ok=True)
            except OSError:
                pass
            for index, chunk_path in enumerate(chunk_paths, start=1):
                chunk_dur = _ffprobe_duration_seconds(Path(chunk_path))
                persisted_chunk_path = _persist_local_media_path(chunk_path, folder="stories")
                part_caption = f"{caption.strip()} (Part {index})".strip()
                db.add(
                    Story(
                        author_id=current_user.id,
                        media_path=persisted_chunk_path,
                        media_type="video",
                        duration_seconds=min(60, chunk_dur),
                        caption=part_caption,
                        sticker_data=sticker_data_clean,
                    )
                )
        created_notifications = _create_notifications(
            db=db,
            recipient_ids=follower_ids,
            actor_id=current_user.id,
            event_type="new_story",
            title=f"@{current_user.username} posted a new story",
            message=(caption.strip() or "New 24h story")[:160],
        )
        db.commit()
        _publish_notification_rows(created_notifications)
        _bump_feed_cache_version()
        newest = (
            db.execute(select(Story).where(Story.author_id == current_user.id).order_by(desc(Story.id)).limit(1))
            .scalars()
            .first()
        )
        if not newest:
            raise HTTPException(status_code=500, detail="Failed to save story")
        return _build_story_out(newest, current_user.id)

    raise HTTPException(status_code=400, detail="Only image and video stories are supported")


@app.get("/api/stories/bar", response_model=list[StoryBarUserOut])
def story_bar(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    following_ids = (
        db.execute(select(UserFollow.following_id).where(UserFollow.follower_id == current_user.id)).scalars().all()
    )
    allowed_author_ids = [current_user.id, *following_ids]
    allowed_author_ids = [
        author_id
        for author_id in allowed_author_ids
        if author_id == current_user.id
        or (
            not _is_blocked_between(current_user.id, author_id, db)
            and not _is_visibility_hidden(author_id, current_user.id, "story", db)
        )
    ]
    cutoff = _story_cutoff()

    stories = (
        db.execute(
            select(Story)
            .where(Story.author_id.in_(allowed_author_ids), Story.created_at >= cutoff)
            .options(
                joinedload(Story.author).joinedload(User.profile_photo),
                joinedload(Story.views),
            )
            .order_by(desc(Story.created_at))
        )
        .unique()
        .scalars()
        .all()
    )

    grouped: dict[int, list[Story]] = {}
    for story in stories:
        grouped.setdefault(story.author_id, []).append(story)

    rows: list[StoryBarUserOut] = []
    for author_id, user_stories in grouped.items():
        author = user_stories[0].author
        latest = max(item.created_at for item in user_stories)
        ordered_user_stories = sorted(user_stories, key=lambda item: item.created_at)
        has_unseen = any(not any(view.viewer_id == current_user.id for view in item.views) for item in ordered_user_stories)
        rows.append(
            StoryBarUserOut(
                user=_build_user_out(author, db, current_user.id),
                has_unseen=has_unseen,
                latest_story_at=latest,
                stories=[_build_story_out(item, current_user.id) for item in ordered_user_stories],
            )
        )

    rows.sort(
        key=lambda row: (
            0 if row.user.id == current_user.id else 1,
            -row.latest_story_at.timestamp(),
        )
    )
    return rows


@app.post("/api/stories/{story_id}/view")
def mark_story_view(story_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    story = (
        db.execute(select(Story).options(joinedload(Story.views)).where(Story.id == story_id))
        .unique()
        .scalars()
        .first()
    )
    if not story or story.created_at < _story_cutoff():
        raise HTTPException(status_code=404, detail="Story not found")
    if _is_blocked_between(current_user.id, story.author_id, db):
        raise HTTPException(status_code=403, detail="You cannot view this story")
    if _is_visibility_hidden(story.author_id, current_user.id, "story", db):
        raise HTTPException(status_code=403, detail="This story is hidden from you")

    if story.author_id != current_user.id:
        follow = (
            db.execute(
                select(UserFollow).where(
                    UserFollow.follower_id == current_user.id,
                    UserFollow.following_id == story.author_id,
                )
            )
            .scalars()
            .first()
        )
        if not follow:
            raise HTTPException(status_code=403, detail="You can only view stories from followed users")

    existing = (
        db.execute(
            select(StoryView).where(
                StoryView.story_id == story.id,
                StoryView.viewer_id == current_user.id,
            )
        )
        .scalars()
        .first()
    )
    if not existing:
        db.add(StoryView(story_id=story.id, viewer_id=current_user.id))
        db.commit()
    return {"detail": "Story marked as viewed"}


@app.get("/api/users/{user_id}/posts", response_model=FeedOut)
def user_feed(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    if not db.get(User, user_id):
        raise HTTPException(status_code=404, detail="User not found")
    if _is_blocked_between(current_user.id, user_id, db):
        return FeedOut(posts=[])

    posts = (
        db.execute(
            select(Post)
            .where(Post.author_id == user_id)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
                joinedload(Post.likes),
                joinedload(Post.comments),
            )
            .order_by(desc(Post.created_at))
        )
        .unique()
        .scalars()
        .all()
    )
    return FeedOut(posts=[_build_post_out(post, db, current_user.id) for post in posts])


@app.get("/api/users/{user_id}/profile", response_model=ProfileOut)
def public_user_profile(user_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == user_id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if _is_blocked_between(current_user.id, user.id, db):
        hidden_user = UserOut(
            id=user.id,
            username=f"private_user_{user.id}",
            email="",
            gender="prefer_not_to_say",
            full_name="Profile unavailable",
            bio="This user has hidden their profile from you.",
            profile_photo_url="/static/default-avatar.svg",
            post_count=0,
            follower_count=0,
            following_count=0,
            is_following=False,
        )
        return ProfileOut(user=hidden_user, posts=[])
    if current_user.id != user.id:
        last_view = (
            db.execute(
                select(ProfileView)
                .where(
                    ProfileView.viewer_id == current_user.id,
                    ProfileView.viewed_user_id == user.id,
                )
                .order_by(desc(ProfileView.created_at))
                .limit(1)
            )
            .scalars()
            .first()
        )
        now = datetime.utcnow()
        should_track = not last_view or (now - last_view.created_at) >= timedelta(minutes=10)
        if should_track:
            db.add(ProfileView(viewer_id=current_user.id, viewed_user_id=user.id))
            db.commit()

    posts = (
        db.execute(
            select(Post)
            .where(Post.author_id == user.id)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
                joinedload(Post.likes),
                joinedload(Post.comments),
            )
            .order_by(desc(Post.created_at))
        )
        .unique()
        .scalars()
        .all()
    )

    return ProfileOut(
        user=_build_user_out(user, db, current_user.id),
        posts=[_build_post_out(post, db, current_user.id) for post in posts],
    )


@app.get("/api/me/profile", response_model=ProfileOut)
def my_profile(current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    user = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == current_user.id)).scalars().first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    posts = (
        db.execute(
            select(Post)
            .where(Post.author_id == user.id)
            .options(
                joinedload(Post.author).joinedload(User.profile_photo),
                joinedload(Post.screenshots),
                joinedload(Post.likes),
                joinedload(Post.comments),
            )
            .order_by(desc(Post.created_at))
        )
        .unique()
        .scalars()
        .all()
    )

    return ProfileOut(
        user=_build_user_out(user, db, current_user.id),
        posts=[_build_post_out(post, db, current_user.id) for post in posts],
    )


@app.post("/api/help-center/submit")
def submit_help_center_message(
    topic: str = Form(...),
    message: str = Form(...),
    current_user: User = Depends(_require_user),
):
    topic_key = (topic or "").strip().lower()
    subject_prefix = HELP_CENTER_TOPICS.get(topic_key)
    if not subject_prefix:
        raise HTTPException(status_code=400, detail="Invalid help option selected.")

    message_clean = (message or "").strip()
    if len(message_clean) < 8:
        raise HTTPException(status_code=400, detail="Please enter at least 8 characters.")
    if len(message_clean) > 4000:
        raise HTTPException(status_code=400, detail="Message is too long. Keep it under 4000 characters.")

    user_email = (current_user.email or "").strip().lower()
    user_phone = (current_user.mobile_number or "").strip()
    body = (
        f"{subject_prefix}\n\n"
        f"User details:\n"
        f"- User ID: {current_user.id}\n"
        f"- Username: @{current_user.username}\n"
        f"- Full name: {current_user.full_name}\n"
        f"- Email: {user_email or '(not set)'}\n"
        f"- Mobile: {user_phone or '(not set)'}\n"
        f"- Sent at (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
        f"Message:\n{message_clean}\n"
    )
    delivered, mail_status = _send_plain_email(
        HELP_CENTER_EMAIL,
        subject=f"{subject_prefix} | StepNix Help Center",
        content=body,
    )
    if not delivered:
        raise HTTPException(status_code=500, detail=f"Could not deliver message: {mail_status}")
    return {"detail": "Message delivered successfully to help center."}


@app.post("/api/posts/{post_id}/likes")
def like_post(post_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    like = PostLike(post_id=post_id, user_id=current_user.id)
    db.add(like)
    created_like = True
    created_notifications: list[Notification] = []
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        created_like = False

    if created_like and post.author_id != current_user.id:
        created_notifications = _create_notifications(
            db=db,
            recipient_ids={post.author_id},
            actor_id=current_user.id,
            event_type="post_like",
            title=f"@{current_user.username} liked your post",
            message=post.goal_title[:140],
            post_id=post.id,
        )
        db.commit()
        _publish_notification_rows(created_notifications)
    if created_like:
        _bump_feed_cache_version()
    count = db.query(PostLike).filter(PostLike.post_id == post_id).count()
    return {"like_count": count}


@app.delete("/api/posts/{post_id}/likes")
def unlike_post(post_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    if not db.get(Post, post_id):
        raise HTTPException(status_code=404, detail="Post not found")

    like = (
        db.execute(
            select(PostLike).where(
                PostLike.post_id == post_id,
                PostLike.user_id == current_user.id,
            )
        )
        .scalars()
        .first()
    )
    if like:
        db.delete(like)
        db.commit()
        _bump_feed_cache_version()
    count = db.query(PostLike).filter(PostLike.post_id == post_id).count()
    return {"like_count": count}


@app.get("/api/posts/{post_id}/likes/users", response_model=list[UserOut])
def list_post_likers(post_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    likes = (
        db.execute(select(PostLike).where(PostLike.post_id == post_id).order_by(desc(PostLike.id)))
        .scalars()
        .all()
    )
    if not likes:
        return []

    ordered_ids = [item.user_id for item in likes]
    users = (
        db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id.in_(ordered_ids)))
        .scalars()
        .all()
    )
    by_id = {user.id: user for user in users}
    return [_build_user_out(by_id[user_id], db, current_user.id) for user_id in ordered_ids if user_id in by_id]


@app.get("/api/posts/{post_id}/comments", response_model=list[CommentOut])
def list_comments(post_id: int, current_user: User | None = Depends(_optional_user), db: Session = Depends(get_db)):
    comments = (
        db.execute(
            select(Comment)
            .where(Comment.post_id == post_id)
            .options(
                joinedload(Comment.author).joinedload(User.profile_photo),
                joinedload(Comment.reactions),
            )
            .order_by(Comment.created_at.asc())
        )
        .unique()
        .scalars()
        .all()
    )

    output: list[CommentOut] = []
    for comment in comments:
        reaction_count, reaction_summary = _reaction_summary(comment)
        my_reaction = None
        if current_user:
            found = next((r for r in comment.reactions if r.user_id == current_user.id), None)
            if found:
                my_reaction = found.reaction_type
        output.append(
            CommentOut(
                id=comment.id,
                author=_build_user_out(comment.author, db),
                content=comment.content,
                mentions=MENTION_PATTERN.findall(comment.content),
                reaction_count=reaction_count,
                reaction_summary=reaction_summary,
                current_user_reaction=my_reaction,
                created_at=comment.created_at,
            )
        )
    return output


@app.post("/api/posts/{post_id}/comments", response_model=CommentOut)
def add_comment(
    post_id: int,
    payload: CommentCreate,
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    post = db.get(Post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail="Post not found")

    author = db.execute(select(User).options(joinedload(User.profile_photo)).where(User.id == current_user.id)).scalars().first()
    if not author:
        raise HTTPException(status_code=404, detail="User not found")

    comment = Comment(post_id=post_id, author_id=current_user.id, content=payload.content.strip())
    db.add(comment)
    db.commit()
    db.refresh(comment)

    created_notifications: list[Notification] = []
    if post.author_id != current_user.id:
        created_notifications.extend(
            _create_notifications(
                db=db,
                recipient_ids={post.author_id},
                actor_id=current_user.id,
                event_type="post_comment",
                title=f"@{current_user.username} commented on your post",
                message=payload.content.strip()[:160],
                post_id=post.id,
                comment_id=comment.id,
            )
        )
    mentioned_ids = _mentioned_user_ids(
        payload.content.strip(),
        db=db,
        exclude_ids={current_user.id, post.author_id},
    )
    if mentioned_ids:
        created_notifications.extend(
            _create_notifications(
                db=db,
                recipient_ids=mentioned_ids,
                actor_id=current_user.id,
                event_type="comment_mention",
                title=f"@{current_user.username} mentioned you in a comment",
                message=payload.content.strip()[:160],
                post_id=post.id,
                comment_id=comment.id,
            )
        )
    if created_notifications:
        db.commit()
        _publish_notification_rows(created_notifications)
    _bump_feed_cache_version()

    return CommentOut(
        id=comment.id,
        author=_build_user_out(author, db, current_user.id),
        content=comment.content,
        mentions=MENTION_PATTERN.findall(comment.content),
        reaction_count=0,
        reaction_summary={},
        current_user_reaction=None,
        created_at=comment.created_at,
    )


@app.post("/api/comments/{comment_id}/reactions")
def react_to_comment(
    comment_id: int,
    reaction_type: str = Form(...),
    current_user: User = Depends(_require_user),
    db: Session = Depends(get_db),
):
    if reaction_type not in ALLOWED_REACTIONS:
        raise HTTPException(status_code=400, detail="Unsupported reaction type")

    comment = db.get(Comment, comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    existing = (
        db.execute(
            select(CommentReaction).where(
                CommentReaction.comment_id == comment_id,
                CommentReaction.user_id == current_user.id,
            )
        )
        .scalars()
        .first()
    )

    previous_reaction = existing.reaction_type if existing else None
    if existing:
        existing.reaction_type = reaction_type
    else:
        db.add(CommentReaction(comment_id=comment_id, user_id=current_user.id, reaction_type=reaction_type))
    db.commit()

    created_notifications: list[Notification] = []
    if comment.author_id != current_user.id and previous_reaction != reaction_type:
        created_notifications = _create_notifications(
            db=db,
            recipient_ids={comment.author_id},
            actor_id=current_user.id,
            event_type="comment_reaction",
            title=f"@{current_user.username} reacted to your comment",
            message=f"Reaction: {reaction_type}",
            post_id=comment.post_id,
            comment_id=comment.id,
        )
        db.commit()
        _publish_notification_rows(created_notifications)

    comment_row = (
        db.execute(select(Comment).options(joinedload(Comment.reactions)).where(Comment.id == comment_id))
        .unique()
        .scalars()
        .first()
    )
    if not comment_row:
        return {"reaction_count": 0, "reaction_summary": {}}

    count, summary = _reaction_summary(comment_row)
    return {"reaction_count": count, "reaction_summary": summary}


@app.get("/api/comments/{comment_id}/reactions", response_model=list[CommentReactionDetailOut])
def list_comment_reactions(comment_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    comment = db.get(Comment, comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    rows = (
        db.execute(
            select(CommentReaction)
            .where(CommentReaction.comment_id == comment_id)
            .options(joinedload(CommentReaction.user).joinedload(User.profile_photo))
            .order_by(desc(CommentReaction.id))
        )
        .scalars()
        .all()
    )
    return [
        CommentReactionDetailOut(
            id=row.id,
            reaction_type=row.reaction_type,
            user=_build_comment_reaction_user_out(row.user),
        )
        for row in rows
    ]


@app.delete("/api/comments/{comment_id}/reactions")
def remove_comment_reaction(comment_id: int, current_user: User = Depends(_require_user), db: Session = Depends(get_db)):
    comment = db.get(Comment, comment_id)
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found")

    existing = (
        db.execute(
            select(CommentReaction).where(
                CommentReaction.comment_id == comment_id,
                CommentReaction.user_id == current_user.id,
            )
        )
        .scalars()
        .first()
    )
    if existing:
        db.delete(existing)
        db.commit()

    refreshed = (
        db.execute(select(Comment).options(joinedload(Comment.reactions)).where(Comment.id == comment_id))
        .unique()
        .scalars()
        .first()
    )
    if not refreshed:
        return {"reaction_count": 0, "reaction_summary": {}}

    count, summary = _reaction_summary(refreshed)
    return {"reaction_count": count, "reaction_summary": summary}
