FROM docker.io/cloudflare/sandbox:0.7.0-python

RUN pip3 install --no-cache-dir claude-agent-sdk && rm -rf /root/.cache
RUN apt-get update && apt-get install -y --no-install-recommends git curl && rm -rf /var/lib/apt/lists/*

COPY runtime/run_prompt.py /opt/ciel/run_prompt.py

# Base image already has correct ENTRYPOINT configured
