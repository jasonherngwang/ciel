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


def build_system_prompt(history: List[Dict[str, str]], branch: str = None, repo_url: str = None, agent_name: str = "agent") -> str:
    """Build system prompt with conversation history and git context."""
    base = """You are a coding agent working in /workspace.

Available tools: Read, Write, Edit, Bash, Glob, Grep
Do not try to use todo list tools - respond directly to the user in chat instead.
"""

    # Add Git workflow instructions if working with a repository
    if repo_url:
        if branch:
            # Agent already has a branch
            base += f"""
## Git Workflow

You are working on branch: {branch} in a cloned GitHub repository.
Repository URL: {repo_url}

The git remote is already configured with authentication - you can push directly.

**Autonomous Git Workflow:**
When you complete a task or make changes:
1. Stage your changes: `git add <files>`
2. Commit with a descriptive message: `git commit -m "Brief description of changes"`
3. Push to GitHub: `git push origin {branch}` (use `-u` flag on first push)
4. Create a PR automatically: `gh pr create --title "Brief title" --body "What changed and why" --base main`

**IMPORTANT: After successfully completing any user request that modifies files, you should automatically:**
- Commit the changes with a clear message
- Push to GitHub
- Create a pull request (unless one already exists for this branch)
- Tell the user the PR URL

You don't need to ask permission - just do it as part of completing the task.

Check for existing PRs first: `gh pr list --head {branch}`
If a PR already exists, just push the new commits to it. Don't create a duplicate PR.

"""
        else:
            # Agent needs to create a branch
            base += f"""
## Git Workflow

You are working in a cloned GitHub repository.
Repository URL: {repo_url}

**First Task: Create Your Working Branch**
Before making any changes, you should:
1. Check current branch: `git branch --show-current`
2. Create a descriptive branch name based on what you're working on:
   - Format: `ciel/brief-task-description`
   - Examples: `ciel/add-login-form`, `ciel/fix-auth-bug`, `ciel/update-readme`
3. Create and switch to the branch: `git checkout -b ciel/your-task-name`

**Autonomous Git Workflow:**
After creating your branch and completing work:
1. Stage your changes: `git add <files>`
2. Commit with a descriptive message: `git commit -m "Brief description of changes"`
3. Push to GitHub: `git push -u origin ciel/your-branch-name` (use `-u` flag on first push)
4. Create a PR automatically: `gh pr create --title "Brief title" --body "What changed and why" --base main`

**IMPORTANT: After successfully completing any user request that modifies files, you should automatically:**
- Create a descriptive branch if you haven't already
- Commit the changes with a clear message
- Push to GitHub
- Create a pull request
- Tell the user the PR URL and branch name

You don't need to ask permission - just do it as part of completing the task.

"""
    else:
        base += """
## Git Workflow

You are NOT working in a GitHub repository. Git operations (push, PR creation) are not available.
If the user asks to push changes to GitHub, explain that this agent wasn't created with a repository.

"""

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

        payload = json.loads(stdin_data)
        prompt = payload.get("prompt", "")
        history = payload.get("history", [])
        branch = payload.get("branch")
        repo_url = payload.get("repoUrl")
        agent_name = payload.get("agentName", "agent")

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
            from claude_agent_sdk.types import (
                SystemMessage,
                AssistantMessage,
                ResultMessage,
                StreamEvent,
                TextBlock,
                ToolUseBlock,
                ToolResultBlock,
                ThinkingBlock
            )
        except ImportError as e:
            emit("error", f"Failed to import claude_agent_sdk: {e}")
            sys.exit(1)

        # Build system prompt with history and git context
        system_prompt = build_system_prompt(history, branch, repo_url, agent_name)

        # Configure options (API key is read from ANTHROPIC_API_KEY env var by SDK)
        options = ClaudeAgentOptions(
            model="claude-haiku-4-5-20251001",
            system_prompt=system_prompt,
            permission_mode="acceptEdits",
            allowed_tools=["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
            include_partial_messages=True,
            cwd="/workspace"
        )

        # Execute query and stream results
        total_cost = 0.0
        duration_start = None

        import asyncio
        import time

        async def run_query() -> None:
            nonlocal total_cost, duration_start
            duration_start = time.time()

            async for message in query(prompt=prompt, options=options):
                # Skip SystemMessage (system prompt echo)
                if isinstance(message, SystemMessage):
                    continue

                # Handle streaming events (real-time progress)
                elif isinstance(message, StreamEvent):
                    event = message.event
                    if event.get("type") == "content_block_delta":
                        delta = event.get("delta", {})
                        if delta.get("type") == "text_delta":
                            # Real-time text chunks
                            text_chunk = delta.get("text", "")
                            emit("assistant_text", text_chunk)

                # Handle complete assistant messages
                elif isinstance(message, AssistantMessage):
                    # Check for errors
                    if message.error:
                        emit("error", f"Assistant error: {message.error}")
                        continue

                    # Process content blocks
                    for block in message.content:
                        if isinstance(block, TextBlock):
                            # Text response (only emit if not streaming)
                            # (when include_partial_messages=True, text comes via StreamEvent)
                            pass

                        elif isinstance(block, ThinkingBlock):
                            # Extended thinking
                            emit("thinking", block.thinking)

                        elif isinstance(block, ToolUseBlock):
                            # Tool call
                            emit("tool_use", f"Using tool: {block.name}",
                                 name=block.name,
                                 input=block.input,
                                 tool_use_id=block.id)

                        elif isinstance(block, ToolResultBlock):
                            # Tool result
                            content = str(block.content) if block.content else ""
                            # Truncate long results
                            if len(content) > 1000:
                                content = content[:1000] + "... (truncated)"
                            emit("tool_result", content,
                                 tool_use_id=block.tool_use_id,
                                 is_error=block.is_error or False)

                # Handle final result
                elif isinstance(message, ResultMessage):
                    total_cost = message.total_cost_usd or 0.0
                    if message.is_error:
                        emit("error", f"Session failed: {message.result or 'Unknown error'}")

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
        import traceback
        print(traceback.format_exc(), file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
