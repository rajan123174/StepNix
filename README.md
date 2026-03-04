# Goal Journal (FastAPI + PostgreSQL + HTML/CSS/JS)

A personal blog-style progress tracker where users can:
- Register/Login with authentication
- Login using username or email
- Forgot password with email OTP
- Share daily progress posts for goals
- Add captions and upload screenshots
- Add a profile photo (DP)
- Like posts
- Comment on posts
- React to comments (`like`, `love`, `celebrate`)
- Delete your own posts
- Mention users in comments with `@username`
- View global feed and dedicated individual profile pages

## Tech Stack
- Backend: FastAPI, SQLAlchemy, PostgreSQL
- Frontend: Vanilla HTML, CSS, JavaScript
- Storage: PostgreSQL for data + local folder for screenshot uploads

## Project Structure
- `/app` FastAPI backend
- `/static` frontend files and uploaded screenshots

## Setup
1. Create PostgreSQL database:
```sql
CREATE DATABASE personal_blog;
```

2. Install dependencies:
```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

3. Configure environment:
```bash
cp .env.example .env
```
Edit `.env` if your Postgres credentials are different.

4. Run app:
```bash
python -m uvicorn app.main:app --reload
```

5. Open in browser:
- `http://127.0.0.1:8000/community-feed`

## Frontend Pages
- `/create-profile` Create profile + optional DP upload
- `/new-progress` Post daily progress
- `/community-feed` Community feed with likes/comments
- `/profile` Individual user profile page with profile photo and user-only posts

## API Endpoints
- `POST /api/auth/register` register user with optional profile photo
- `POST /api/auth/login` login
- `POST /api/auth/logout` logout
- `GET /api/auth/me` current logged user
- `POST /api/auth/forgot-password` send OTP to registered email
- `GET /api/auth/forgot-password/captcha` captcha challenge for OTP request
- `POST /api/auth/verify-otp` verify OTP before enabling reset
- `POST /api/auth/reset-password` reset password after OTP verification
- `GET /api/users` list users
- `GET /api/users/{user_id}` get one user
- `POST /api/me/photo` upload/update current user profile photo
- `POST /api/posts` create progress post with screenshots
- `DELETE /api/posts/{post_id}` delete post (owner only)
- `GET /api/feed` global feed
- `GET /api/users/{user_id}/posts` profile feed
- `GET /api/me/profile` profile details + own posts
- `POST /api/posts/{post_id}/likes` like a post
- `GET /api/posts/{post_id}/comments` list comments
- `POST /api/posts/{post_id}/comments` add comment
- `POST /api/comments/{comment_id}/reactions` react to comment
- `DELETE /api/comments/{comment_id}/reactions` remove your reaction from a comment

## Notes
- Mentions are parsed from comment text using `@username` format.
- Screenshots are saved in `static/uploads`.
- For production: use migrations (Alembic), object storage for images, and authentication.
- OTP email requires SMTP environment variables:
  - `SMTP_HOST`
  - `SMTP_PORT` (default `587`)
  - `SMTP_USER`
  - `SMTP_PASSWORD`
  - `SMTP_SENDER` (optional)
- Additional forgot-password protections enabled:
  - Captcha is required before OTP request
  - 60-second cooldown between OTP requests
  - Max 3 OTP requests per 10 minutes (email/IP)
  - Max 10 OTP requests per day per email
- Rate-limit behavior:
  - For local development set `APP_ENV=development` and `ENFORCE_OTP_LIMITS=0`
  - For production set `APP_ENV=production` and `ENFORCE_OTP_LIMITS=1`
