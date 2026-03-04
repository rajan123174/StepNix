bind = "0.0.0.0:8000"
workers = 4
worker_class = "uvicorn.workers.UvicornWorker"
graceful_timeout = 30
timeout = 120
keepalive = 5
accesslog = "-"
errorlog = "-"
