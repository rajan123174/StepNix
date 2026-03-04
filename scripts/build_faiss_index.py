from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, cast

import faiss  # type: ignore
import numpy as np
from sqlalchemy import select
from sqlalchemy.orm import Session, joinedload

from app.database import engine
from app.models import Post, User


FEED_EMBED_DIM = max(64, min(1024, int(os.getenv("FEED_EMBED_DIM", "256") or "256")))
OUTPUT_PATH = Path(
    os.getenv(
        "FAISS_INDEX_PATH",
        "/home/ubuntu/personalBlog/data/faiss/personalization.index",
    )
)


def post_text_signature(post: Post) -> str:
    parts = [
        post.goal_title or "",
        post.caption or "",
        post.day_experience or "",
        post.author.username if post.author else "",
        post.author.full_name if post.author else "",
    ]
    return " \n".join(parts)


def hash_embed_text(text: str, dim: int) -> np.ndarray:
    vec = np.zeros(dim, dtype=np.float32)
    tokens = re.findall(r"[a-z0-9_]+", (text or "").lower())
    if not tokens:
        return vec
    for token in tokens:
        digest = __import__("hashlib").sha256(token.encode("utf-8")).digest()
        idx = int.from_bytes(digest[:4], "big") % dim
        sign = 1.0 if (digest[4] & 1) else -1.0
        vec[idx] += sign
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with Session(engine) as session:
        posts = (
            session.execute(
                select(Post)
                .options(joinedload(Post.author).joinedload(User.profile_photo))
                .order_by(Post.id.asc())
            )
            .scalars()
            .all()
        )

    valid_posts: list[Post] = []
    vectors: list[np.ndarray] = []
    for post in posts:
        vector = hash_embed_text(post_text_signature(post), FEED_EMBED_DIM)
        if not np.any(vector):
            continue
        valid_posts.append(post)
        vectors.append(vector)

    if not vectors:
        raise SystemExit("No posts with valid vectors were found. Create some posts first.")

    matrix = np.stack(vectors, axis=0).astype(np.float32)
    index = cast(Any, faiss.IndexFlatIP(FEED_EMBED_DIM))
    index.add(cast(Any, matrix))
    cast(Any, faiss).write_index(index, str(OUTPUT_PATH))

    metadata = {
        "dim": FEED_EMBED_DIM,
        "post_ids": [int(post.id) for post in valid_posts],
        "generated_count": len(valid_posts),
    }
    metadata_path = OUTPUT_PATH.with_suffix(f"{OUTPUT_PATH.suffix}.meta.json")
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    print(f"Wrote index: {OUTPUT_PATH}")
    print(f"Wrote metadata: {metadata_path}")
    print(f"Indexed posts: {len(valid_posts)}")


if __name__ == "__main__":
    main()
