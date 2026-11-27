FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb x11vnc novnc websockify python3 socat ca-certificates fonts-liberation && rm -rf /var/lib/apt/lists/*
COPY start.sh /opt/codali/start.sh
COPY preview.py /opt/codali/preview.py
USER 1000:1000
ENV HOME=/tmp/home DISPLAY=:99
ENTRYPOINT ["/bin/sh", "/opt/codali/start.sh"]
