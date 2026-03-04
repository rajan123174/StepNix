# Deployment Guide

This repository can be deployed with the current UI unchanged:

- Frontend on Vercel using the `static/` folder
- Backend on AWS EC2 using Gunicorn + Uvicorn
- Database on Neon PostgreSQL
- Redis for caching and pub/sub
- FAISS index stored on the EC2 server and loaded once at app startup
- AWS S3 for videos and images

## Frontend on Vercel

1. Import this repository into Vercel.
2. Set framework preset to `Other`.
3. Keep the root directory as the repository root.
4. Add Vercel environment variables:

```bash
API_BASE_URL=https://api.your-domain.com
WS_BASE_URL=wss://api.your-domain.com
```

5. Set the build command in Vercel to:

```bash
bash scripts/render_frontend_config.sh
```

6. Deploy.

`vercel.json` rewrites clean URLs like `/community-feed` to the matching HTML file under `static/`.

## Backend on AWS EC2

1. Launch an Ubuntu 22.04 EC2 instance.
2. Open ports `22`, `80`, and `443` in the security group.
3. Install system packages:

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip nginx
```

4. Clone the project and install Python dependencies:

```bash
git clone <your-repo-url> personalBlog
cd personalBlog
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
chmod +x scripts/start.sh
chmod +x scripts/render_frontend_config.sh
```

5. Create `.env` in the project root.
6. Test the backend:

```bash
source .venv/bin/activate
gunicorn -k uvicorn.workers.UvicornWorker main:app --workers 4 --bind 0.0.0.0:8000
```

7. Install the systemd service:

```bash
sudo cp deploy/personalblog.service /etc/systemd/system/personalblog.service
sudo systemctl daemon-reload
sudo systemctl enable personalblog
sudo systemctl start personalblog
```

8. Install the Nginx site config:

```bash
sudo cp deploy/nginx.personalblog.conf /etc/nginx/sites-available/personalblog
sudo ln -s /etc/nginx/sites-available/personalblog /etc/nginx/sites-enabled/personalblog
sudo nginx -t
sudo systemctl restart nginx
```

9. Add TLS:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.com
```

## Neon PostgreSQL

1. Create a Neon project.
2. Copy the connection string.
3. Set:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DATABASE?sslmode=require
```

Use a Neon region close to the EC2 region to reduce latency.

## Redis

Use either AWS ElastiCache Redis or another managed Redis service. Set:

```bash
REDIS_URL=redis://your-redis-host:6379/0
```

Recommended usage:

- cache feed responses
- cache notification unread counts
- pub/sub for chat and notification fanout
- temporary session and realtime state

## FAISS

Place the FAISS file on the EC2 instance, for example:

```bash
/home/ubuntu/personalBlog/data/faiss/personalization.index
```

Set:

```bash
FAISS_INDEX_PATH=/home/ubuntu/personalBlog/data/faiss/personalization.index
```

For best performance:

- keep the FAISS file on local disk
- load it once when the app starts
- restart the service when you replace the FAISS index file

## S3

Create an S3 bucket for media storage and set:

```bash
AWS_ACCESS_KEY=your-access-key
AWS_SECRET_KEY=your-secret-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket-name
```

Recommended S3 CORS:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": ["https://your-vercel-domain.vercel.app", "https://your-domain.com"],
    "ExposeHeaders": ["ETag"]
  }
]
```

## Suggested production `.env`

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/DATABASE?sslmode=require
REDIS_URL=redis://your-redis-host:6379/0
AWS_ACCESS_KEY=your-access-key
AWS_SECRET_KEY=your-secret-key
AWS_REGION=us-east-1
S3_BUCKET_NAME=your-bucket-name
FAISS_INDEX_PATH=/home/ubuntu/personalBlog/data/faiss/personalization.index
API_BASE_URL=https://api.your-domain.com
APP_ENV=production
ENFORCE_OTP_LIMITS=1
```

## Performance checklist

- Put EC2, Redis, and S3 in the same AWS region.
- Choose a Neon region close to EC2.
- Keep large uploads in S3, not on the app server.
- Put Nginx in front of Gunicorn.
- Start with 4 Gunicorn workers and tune after measuring CPU and RAM.
- Keep the FAISS index on local disk and reload only on deploys.
