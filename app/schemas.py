from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    full_name: str = Field(min_length=2, max_length=120)
    bio: str = Field(default="", max_length=250)
    password: str = Field(min_length=6, max_length=128)


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    gender: str = "prefer_not_to_say"
    full_name: str
    bio: str
    profile_photo_url: str | None = None
    post_count: int = 0
    follower_count: int = 0
    following_count: int = 0
    current_streak: int = 0
    is_following: bool = False
    is_active: bool = False


class CommentCreate(BaseModel):
    content: str = Field(min_length=1)


class CommentOut(BaseModel):
    id: int
    author: UserOut
    content: str
    mentions: list[str]
    reaction_count: int
    reaction_summary: dict[str, int]
    current_user_reaction: str | None = None
    created_at: datetime


class PostOut(BaseModel):
    id: int
    author: UserOut
    goal_title: str
    caption: str
    day_experience: str
    screenshots: list[str]
    like_count: int
    liked_by_me: bool = False
    comment_count: int
    new_streak_count: int = 0
    streak_just_increased: bool = False
    created_at: datetime


class FeedOut(BaseModel):
    posts: list[PostOut]
    suggested_users: list[UserOut] = []
    ranking_mode: str = "heuristic"
    ranking_latency_ms: int = 0


class StoryOut(BaseModel):
    id: int
    media_url: str
    media_type: str
    duration_seconds: int
    caption: str
    sticker_data: list[dict[str, str | int | float]]
    created_at: datetime
    viewed_by_me: bool = False


class StoryBarUserOut(BaseModel):
    user: UserOut
    has_unseen: bool = False
    latest_story_at: datetime
    stories: list[StoryOut]


class ProfileOut(BaseModel):
    user: UserOut
    posts: list[PostOut]


class LoginIn(BaseModel):
    identifier: str
    password: str


class AuthOut(BaseModel):
    token: str
    user: UserOut


class NotificationActorOut(BaseModel):
    id: int
    username: str
    full_name: str
    profile_photo_url: str | None = None


class NotificationOut(BaseModel):
    id: int
    event_type: str
    title: str
    message: str
    post_id: int | None = None
    comment_id: int | None = None
    is_read: bool
    created_at: datetime
    actor: NotificationActorOut


class CommentReactionUserOut(BaseModel):
    id: int
    username: str
    full_name: str
    profile_photo_url: str | None = None


class CommentReactionDetailOut(BaseModel):
    id: int
    reaction_type: str
    user: CommentReactionUserOut


class ChatAuthStatusOut(BaseModel):
    registered_email: str = ""
    chat_enabled: bool = False


class ChatAuthOut(BaseModel):
    session_token: str
    email: str
    expires_in_seconds: int = 300


class ChatMessageOut(BaseModel):
    id: int
    sender: UserOut
    receiver: UserOut
    content: str
    created_at: datetime
    seen_at: datetime | None = None
    deleted_for_everyone: bool = False
    can_delete_for_everyone: bool = False


class ChatConversationOut(BaseModel):
    user: UserOut
    last_message: str
    last_message_at: datetime


class ChatThreadOut(BaseModel):
    with_user: UserOut
    messages: list[ChatMessageOut]
    partner_is_typing: bool = False
