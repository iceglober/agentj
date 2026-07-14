FROM debian:bookworm-slim

# AgentJ needs Git to create worktrees. The remaining packages support ordinary
# shell provisioning without selecting a language-specific runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git jq \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
