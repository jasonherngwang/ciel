#!/usr/bin/env python3
"""Ciel runtime: executes Claude Agent SDK prompts inside sandbox containers."""

import json
import os
import sys
import signal
from typing import Any, Dict, List

# Timeout handling
TIMEOUT_SECONDS = 300  # 5 minutes


def timeout_handler(signum: int, frame: Any) -> None:
    """Handle timeout by raising an exception."""
    raise TimeoutError("Prompt execution exceeded 5 minute timeout")


def build_system_prompt(history: List[Dict[str, str]]) -> str:
    """Build system prompt with conversation history."""
    base = "You are a coding agent working in /workspace.\n"

    if not history:
        return base

    lines = ["", "## Previous Conversation", ""]
    for msg in history:
        msg_type = msg.get("type", "")
        content = msg.get("content", "")

        if msg_type == "user":
            lines.append(f"User: {content}")
        elif msg_type == "assistant_text":
            lines.append(f"Assistant: {content}")
        elif msg_type == "tool_use":
            tool_name = msg.get("name", "unknown")
            lines.append(f"[Used tool: {tool_name}]")
        elif msg_type == "tool_result":
            lines.append("[Tool result received]")

    lines.extend(["", "## Current Request", ""])
    return base + "\n".join(lines)


def emit(message_type: str, content: str, **extra: Any) -> None:
    """Emit a JSON line message to stdout."""
    msg = {"type": message_type, "content": content, **extra}
    print(json.dumps(msg), flush=True)


def main() -> None:
    """Main execution function."""
    # Set up timeout
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.alarm(TIMEOUT_SECONDS)

    try:
        # Read stdin payload
        stdin_data = sys.stdin.read()
        if not stdin_data:
            emit("error", "No input provided on stdin")
            sys.exit(1)

        # Debug: log to stderr so it shows in container logs
        print(f"DEBUG: Received stdin data length: {len(stdin_data)}", file=sys.stderr, flush=True)

        payload = json.loads(stdin_data)
        prompt = payload.get("prompt", "")
        history = payload.get("history", [])

        print(f"DEBUG: Prompt length: {len(prompt)}, History length: {len(history)}", file=sys.stderr, flush=True)

        if not prompt:
            emit("error", "No prompt provided in input")
            sys.exit(1)

        # Get API key from environment
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if not api_key:
            emit("error", "ANTHROPIC_API_KEY not set in environment")
            sys.exit(1)

        # Import Claude Agent SDK (after env checks)
        try:
            from claude_agent_sdk import query, ClaudeAgentOptions
        except ImportError as e:
            emit("error", f"Failed to import claude_agent_sdk: {e}")
            sys.exit(1)

        # Build system prompt with history
        system_prompt = build_system_prompt(history)
        print(f"DEBUG: System prompt length: {len(system_prompt)}", file=sys.stderr, flush=True)

        # Configure options (API key is read from ANTHROPIC_API_KEY env var by SDK)
        # Note: system_prompt might need to be passed differently
        try:
            options = ClaudeAgentOptions(
                model="claude-haiku-4-5-20251001",
                system_prompt=system_prompt,
                permission_mode="acceptEdits",
                allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
                include_partial_messages=True,
                cwd="/workspace"
            )
            print(f"DEBUG: Options created successfully", file=sys.stderr, flush=True)
        except Exception as e:
            print(f"DEBUG: Failed to create options: {e}", file=sys.stderr, flush=True)
            raise

        # Execute query and stream results
        total_cost = 0.0
        duration_start = None

        import asyncio
        import time

        async def run_query() -> None:
            nonlocal total_cost, duration_start
            duration_start = time.time()

            print(f"DEBUG: Calling query() with prompt", file=sys.stderr, flush=True)
            result = query(prompt=prompt, options=options)
            print(f"DEBUG: query() returned: {type(result)}", file=sys.stderr, flush=True)

            async for message in result:
                print(f"DEBUG: Got message type: {type(message).__name__}", file=sys.stderr, flush=True)

                # Skip SystemMessage - it's just the system prompt echo
                if type(message).__name__ == 'SystemMessage':
                    print(f"DEBUG: Skipping SystemMessage", file=sys.stderr, flush=True)
                    continue

                message_dict = message.model_dump() if hasattr(message, 'model_dump') else dict(message)
                message_type = message_dict.get("type", "unknown")
                print(f"DEBUG: Message type from dict: {message_type}", file=sys.stderr, flush=True)

                # Map SDK message types to our types
                if message_type == "text":
                    # Assistant text response
                    content = message_dict.get("text", message_dict.get("content", ""))
                    emit("assistant_text", content)

                elif message_type == "tool_use":
                    # Tool execution
                    tool_name = message_dict.get("name", "unknown")
                    tool_input = message_dict.get("input", {})
                    emit("tool_use", f"Using tool: {tool_name}", name=tool_name, input=tool_input)

                elif message_type == "tool_result":
                    # Tool result
                    content = str(message_dict.get("content", ""))
                    # Truncate long results
                    if len(content) > 1000:
                        content = content[:1000] + "... (truncated)"
                    emit("tool_result", content)

                elif message_type == "thinking":
                    # Claude's thinking process
                    content = message_dict.get("thinking", message_dict.get("content", ""))
                    emit("thinking", content)

                elif message_type == "result":
                    # Final result with cost
                    total_cost = message_dict.get("total_cost_usd", 0.0)

                else:
                    # Unknown message type - log but don't crash
                    print(f"DEBUG: Unknown message type: {message_type}", file=sys.stderr, flush=True)

        # Run async query
        asyncio.run(run_query())

        # Emit final result
        duration_ms = int((time.time() - duration_start) * 1000) if duration_start else 0
        emit("result", "Query complete", total_cost_usd=total_cost, duration_ms=duration_ms)

        # Cancel alarm
        signal.alarm(0)
        sys.exit(0)

    except TimeoutError as e:
        emit("error", f"Timeout: {e}")
        sys.exit(1)

    except json.JSONDecodeError as e:
        emit("error", f"Invalid JSON input: {e}")
        sys.exit(1)

    except Exception as e:
        emit("error", f"Execution failed: {type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
