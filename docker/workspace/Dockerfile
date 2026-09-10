# Aurex AI workspace image
# A controlled Linux environment where an AI agent can perform real work.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    jq \
    python3 \
    python3-pip \
    build-essential \
    procps \
    ripgrep \
    sudo \
    poppler-utils \
    tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

# Pin opencode to the same version running on the host. --omit=optional avoids
# npm's flaky musl/glibc optional-dep resolution; the package's own postinstall
# downloads the correct platform binary.
RUN npm install -g --omit=optional opencode-ai@1.18.15

# Non-root agent user with passwordless sudo (safe: disposable container)
RUN useradd --create-home --shell /bin/bash agent \
    && echo "agent ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/agent \
    && chmod 440 /etc/sudoers.d/agent

COPY entrypoint.sh /usr/local/bin/aurex-agent
RUN chmod +x /usr/local/bin/aurex-agent

# The workspace volume is mounted here
RUN mkdir -p /workspace /home/agent/logs && chown -R agent:agent /workspace /home/agent

WORKDIR /workspace
USER agent

# idle loop so the container stays alive; runs are docker exec'd in
ENTRYPOINT ["/bin/bash", "-lc", "tail -f /dev/null"]
