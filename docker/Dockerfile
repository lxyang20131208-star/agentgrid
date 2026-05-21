# Container image for an AgentGrid worker's `container` sandbox mode.
#
# When a worker runs with `--sandbox container`, the coordinator-issued job is
# executed by `docker run`-ing this image with the job workspace bind-mounted
# at /workspace. The image therefore needs the agent CLIs installed.
#
# Build:
#   docker build -t agentgrid-worker -f docker/Dockerfile .
#
# Then run a worker that uses it:
#   agentgrid worker --sandbox container --container-image agentgrid-worker
#
# The worker forwards only allowlisted environment variables into the
# container (the agent's own API keys, locale, PATH) — see src/worker/sandbox.ts.

FROM node:20-slim

# git is commonly needed by coding agents operating on a repo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install the agent CLIs globally so `claude` and `codex` are on PATH.
# Pin or adjust versions to match what your network expects.
RUN npm install -g @anthropic-ai/claude-code @openai/codex || \
    echo "warning: one or more agent CLIs failed to install — adjust as needed"

# Run as an unprivileged user. The bind-mounted /workspace is the only path a
# job should need to write to.
USER node
WORKDIR /workspace

# The sandbox supplies the actual command (e.g. `claude -p ...`) at run time.
CMD ["bash"]
