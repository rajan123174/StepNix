from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    username: Mapped[str] = mapped_column(String(40), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), default="", nullable=False, index=True)
    mobile_number: Mapped[str] = mapped_column(String(24), default="", nullable=False, index=True)
    gender: Mapped[str] = mapped_column(String(20), default="prefer_not_to_say", nullable=False, index=True)
    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    bio: Mapped[str] = mapped_column(String(250), default="", nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), default="", nullable=False)

    posts: Mapped[list["Post"]] = relationship(back_populates="author", cascade="all, delete-orphan")
    comments: Mapped[list["Comment"]] = relationship(back_populates="author", cascade="all, delete-orphan")
    likes: Mapped[list["PostLike"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    comment_reactions: Mapped[list["CommentReaction"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    auth_tokens: Mapped[list["AuthToken"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    password_reset_otps: Mapped[list["PasswordResetOTP"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    password_reset_attempts: Mapped[list["PasswordResetAttempt"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    profile_photo: Mapped["UserProfilePhoto | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    following_links: Mapped[list["UserFollow"]] = relationship(
        back_populates="follower",
        foreign_keys="UserFollow.follower_id",
        cascade="all, delete-orphan",
    )
    follower_links: Mapped[list["UserFollow"]] = relationship(
        back_populates="following",
        foreign_keys="UserFollow.following_id",
        cascade="all, delete-orphan",
    )
    stories: Mapped[list["Story"]] = relationship(back_populates="author", cascade="all, delete-orphan")
    story_views: Mapped[list["StoryView"]] = relationship(back_populates="viewer", cascade="all, delete-orphan")
    notifications_received: Mapped[list["Notification"]] = relationship(
        back_populates="recipient",
        foreign_keys="Notification.recipient_id",
        cascade="all, delete-orphan",
    )
    notifications_sent: Mapped[list["Notification"]] = relationship(
        back_populates="actor",
        foreign_keys="Notification.actor_id",
    )
    chat_otp_requests: Mapped[list["ChatEmailOTP"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    chat_device_sessions: Mapped[list["ChatDeviceSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )
    sent_chat_messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="sender",
        foreign_keys="ChatMessage.sender_id",
        cascade="all, delete-orphan",
    )
    received_chat_messages: Mapped[list["ChatMessage"]] = relationship(
        back_populates="receiver",
        foreign_keys="ChatMessage.receiver_id",
        cascade="all, delete-orphan",
    )
    feed_state: Mapped["UserFeedState | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    profile_views_received: Mapped[list["ProfileView"]] = relationship(
        back_populates="viewed_user",
        foreign_keys="ProfileView.viewed_user_id",
        cascade="all, delete-orphan",
    )
    profile_views_made: Mapped[list["ProfileView"]] = relationship(
        back_populates="viewer",
        foreign_keys="ProfileView.viewer_id",
        cascade="all, delete-orphan",
    )
    privacy_setting: Mapped["UserPrivacySetting | None"] = relationship(
        back_populates="user", cascade="all, delete-orphan", uselist=False
    )
    visibility_rules_owned: Mapped[list["UserVisibilityRule"]] = relationship(
        back_populates="owner",
        foreign_keys="UserVisibilityRule.owner_id",
        cascade="all, delete-orphan",
    )
    visibility_rules_targeted: Mapped[list["UserVisibilityRule"]] = relationship(
        back_populates="target_user",
        foreign_keys="UserVisibilityRule.target_user_id",
        cascade="all, delete-orphan",
    )
    blocks_made: Mapped[list["UserBlock"]] = relationship(
        back_populates="blocker",
        foreign_keys="UserBlock.blocker_id",
        cascade="all, delete-orphan",
    )
    blocks_received: Mapped[list["UserBlock"]] = relationship(
        back_populates="blocked_user",
        foreign_keys="UserBlock.blocked_user_id",
        cascade="all, delete-orphan",
    )


class UserProfilePhoto(Base):
    __tablename__ = "user_profile_photos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True
    )
    image_path: Mapped[str] = mapped_column(String(255), nullable=False)

    user: Mapped[User] = relationship(back_populates="profile_photo")


class UserFollow(Base):
    __tablename__ = "user_follows"
    __table_args__ = (UniqueConstraint("follower_id", "following_id", name="uq_user_follow_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    follower_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    following_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    follower: Mapped[User] = relationship(back_populates="following_links", foreign_keys=[follower_id])
    following: Mapped[User] = relationship(back_populates="follower_links", foreign_keys=[following_id])


class Post(Base):
    __tablename__ = "posts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    goal_title: Mapped[str] = mapped_column(String(150), nullable=False)
    caption: Mapped[str] = mapped_column(Text, default="", nullable=False)
    day_experience: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    author: Mapped[User] = relationship(back_populates="posts")
    screenshots: Mapped[list["PostImage"]] = relationship(
        back_populates="post",
        cascade="all, delete-orphan",
        order_by="PostImage.id",
    )
    comments: Mapped[list["Comment"]] = relationship(back_populates="post", cascade="all, delete-orphan")
    likes: Mapped[list["PostLike"]] = relationship(back_populates="post", cascade="all, delete-orphan")


class PostImage(Base):
    __tablename__ = "post_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    image_path: Mapped[str] = mapped_column(String(255), nullable=False)

    post: Mapped[Post] = relationship(back_populates="screenshots")


class Comment(Base):
    __tablename__ = "comments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    post: Mapped[Post] = relationship(back_populates="comments")
    author: Mapped[User] = relationship(back_populates="comments")
    reactions: Mapped[list["CommentReaction"]] = relationship(
        back_populates="comment", cascade="all, delete-orphan"
    )


class CommentReaction(Base):
    __tablename__ = "comment_reactions"
    __table_args__ = (UniqueConstraint("comment_id", "user_id", name="uq_comment_user_reaction"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    comment_id: Mapped[int] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    reaction_type: Mapped[str] = mapped_column(String(20), nullable=False)

    comment: Mapped[Comment] = relationship(back_populates="reactions")
    user: Mapped[User] = relationship(back_populates="comment_reactions")


class PostLike(Base):
    __tablename__ = "post_likes"
    __table_args__ = (UniqueConstraint("post_id", "user_id", name="uq_post_user_like"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    post_id: Mapped[int] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    post: Mapped[Post] = relationship(back_populates="likes")
    user: Mapped[User] = relationship(back_populates="likes")


class Story(Base):
    __tablename__ = "stories"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    media_path: Mapped[str] = mapped_column(String(255), nullable=False)
    media_type: Mapped[str] = mapped_column(String(16), nullable=False, default="image")
    duration_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    caption: Mapped[str] = mapped_column(Text, default="", nullable=False)
    sticker_data: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    author: Mapped[User] = relationship(back_populates="stories")
    views: Mapped[list["StoryView"]] = relationship(back_populates="story", cascade="all, delete-orphan")


class StoryView(Base):
    __tablename__ = "story_views"
    __table_args__ = (UniqueConstraint("story_id", "viewer_id", name="uq_story_view_story_viewer"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    story_id: Mapped[int] = mapped_column(ForeignKey("stories.id", ondelete="CASCADE"), nullable=False, index=True)
    viewer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    story: Mapped[Story] = relationship(back_populates="views")
    viewer: Mapped[User] = relationship(back_populates="story_views")


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    recipient_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    actor_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(180), nullable=False)
    message: Mapped[str] = mapped_column(String(350), default="", nullable=False)
    post_id: Mapped[int | None] = mapped_column(ForeignKey("posts.id", ondelete="CASCADE"), nullable=True, index=True)
    comment_id: Mapped[int | None] = mapped_column(
        ForeignKey("comments.id", ondelete="CASCADE"), nullable=True, index=True
    )
    is_read: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    recipient: Mapped[User] = relationship(back_populates="notifications_received", foreign_keys=[recipient_id])
    actor: Mapped[User] = relationship(back_populates="notifications_sent", foreign_keys=[actor_id])


class AuthToken(Base):
    __tablename__ = "auth_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="auth_tokens")


class UserFeedState(Base):
    __tablename__ = "user_feed_states"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user: Mapped[User] = relationship(back_populates="feed_state")


class ProfileView(Base):
    __tablename__ = "profile_views"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    viewer_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    viewed_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    viewer: Mapped[User] = relationship(back_populates="profile_views_made", foreign_keys=[viewer_id])
    viewed_user: Mapped[User] = relationship(back_populates="profile_views_received", foreign_keys=[viewed_user_id])


class UserPrivacySetting(Base):
    __tablename__ = "user_privacy_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    show_message_seen: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="privacy_setting")


class UserVisibilityRule(Base):
    __tablename__ = "user_visibility_rules"
    __table_args__ = (UniqueConstraint("owner_id", "target_user_id", "rule_type", name="uq_visibility_rule_scope"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    target_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    rule_type: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    owner: Mapped[User] = relationship(back_populates="visibility_rules_owned", foreign_keys=[owner_id])
    target_user: Mapped[User] = relationship(back_populates="visibility_rules_targeted", foreign_keys=[target_user_id])


class UserBlock(Base):
    __tablename__ = "user_blocks"
    __table_args__ = (UniqueConstraint("blocker_id", "blocked_user_id", name="uq_user_block_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    blocker_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    blocked_user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    blocker: Mapped[User] = relationship(back_populates="blocks_made", foreign_keys=[blocker_id])
    blocked_user: Mapped[User] = relationship(back_populates="blocks_received", foreign_keys=[blocked_user_id])


class PasswordResetOTP(Base):
    __tablename__ = "password_reset_otps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_verified: Mapped[bool] = mapped_column(default=False, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="password_reset_otps")


class PasswordResetAttempt(Base):
    __tablename__ = "password_reset_attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    ip_address: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped["User | None"] = relationship(back_populates="password_reset_attempts")


class RegistrationEmailOTP(Base):
    __tablename__ = "registration_email_otps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class AccountDeletionOTP(Base):
    __tablename__ = "account_deletion_otps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    stage: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class SecurityActionOTP(Base):
    __tablename__ = "security_action_otps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    action: Mapped[str] = mapped_column(String(30), nullable=False, index=True)
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    pending_value: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    is_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)


class ChatEmailOTP(Base):
    __tablename__ = "chat_email_otps"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    otp_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    secret_code_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    is_used: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)

    user: Mapped[User] = relationship(back_populates="chat_otp_requests")


class ChatDeviceSession(Base):
    __tablename__ = "chat_device_sessions"
    __table_args__ = (UniqueConstraint("user_id", name="uq_chat_device_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    device_id: Mapped[str] = mapped_column(String(120), nullable=False)
    session_token: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
    last_active_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user: Mapped[User] = relationship(back_populates="chat_device_sessions")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sender_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    receiver_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    seen_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    deleted_for_sender: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    deleted_for_receiver: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    deleted_for_everyone: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    sender: Mapped[User] = relationship(back_populates="sent_chat_messages", foreign_keys=[sender_id])
    receiver: Mapped[User] = relationship(back_populates="received_chat_messages", foreign_keys=[receiver_id])


class ChatTypingState(Base):
    __tablename__ = "chat_typing_states"
    __table_args__ = (UniqueConstraint("user_id", "partner_id", name="uq_chat_typing_pair"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    partner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    is_typing: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False, index=True)

    user: Mapped[User] = relationship(foreign_keys=[user_id])
    partner: Mapped[User] = relationship(foreign_keys=[partner_id])
