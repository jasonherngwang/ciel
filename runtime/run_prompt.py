#!/usr/bin/env python3
"""Ciel runtime: executes Claude Agent SDK prompts inside sandbox containers."""

import json
import sys


def main():
    # Placeholder - full implementation in Phase 4
    payload = json.loads(sys.stdin.read())
    prompt = payload.get("prompt", "")
    print(json.dumps({"type": "status", "content": f"Received prompt: {prompt}"}), flush=True)
    print(json.dumps({"type": "result", "total_cost_usd": 0, "duration_ms": 0}), flush=True)


if __name__ == "__main__":
    main()
