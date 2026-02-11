import { Agent, unstable_callable as callable } from "agents";
import {
  getSandbox,
  parseSSEStream,
  type ExecEvent,
} from "@cloudflare/sandbox";
import type { Env, AgentState, AgentConfig, ChatMessage } from "./types";

export class CielAgent extends Agent<Env, AgentState> {
  initialState: AgentState = {
    agentId: "",
    name: "",
    status: "idle",
    repoUrl: null,
    branch: null,
    messages: [],
    totalCostUsd: 0,
    lastError: null,
  };

  private sequenceCounter = 0;
  private tablesInitialized = false;

  private ensureTables() {
    if (this.tablesInitialized) return;

    this.sql`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    const columns = this.sql<{ name: string }>`
      PRAGMA table_info(messages)
    `;
    if (!columns.some((c) => c.name === "metadata_json")) {
      this.sql`ALTER TABLE messages ADD COLUMN metadata_json TEXT`;
    }

    this.sql`
      CREATE INDEX IF NOT EXISTS idx_messages_seq ON messages(seq)
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT,
        created_at INTEGER NOT NULL
      )
    `;

    this.tablesInitialized = true;
  }

  async onStart() {
    this.ensureTables();

    const maxSeqRows = this.sql<{ max_seq: number | null }>`
      SELECT MAX(seq) as max_seq FROM messages
    `;
    this.sequenceCounter = (maxSeqRows[0]?.max_seq || 0) + 1;

    const recent = this.sql<{
      id: string;
      seq: number;
      type: string;
      content: string;
      metadata_json: string | null;
      created_at: number;
    }>`SELECT * FROM messages ORDER BY seq DESC LIMIT 50`.reverse();

    if (recent.length > 0) {
      this.setState({
        ...this.state,
        messages: recent.map((r) => ({
          id: r.id,
          type: r.type as ChatMessage["type"],
          content: r.content,
          ts: r.created_at,
          seq: r.seq,
          metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
        })),
      });
    }
  }

  @callable({ description: "Provision agent sandbox and clone repository" })
  async provision(config: AgentConfig): Promise<void> {
    try {
      this.ensureTables();

      this.setState({
        ...this.state,
        agentId: config.agentId,
        name: config.name,
        status: "provisioning",
        lastError: null,
      });
      this.log("info", "Starting provisioning", { config });

      const sandbox = getSandbox(this.env.SANDBOX, config.agentId);

      await this.statusMessage("Initializing sandbox...");
      await this.waitForSandbox(sandbox, "Starting container...");

      await sandbox.exec("cd / && rm -rf /workspace");

      if (config.repoUrl) {
        await this.cloneRepo(sandbox, config.repoUrl);
        this.setState({
          ...this.state,
          repoUrl: config.repoUrl,
          branch: null,
        });
      }

      // Verify Claude CLI is available
      await this.statusMessage("Verifying Claude CLI...");
      const cliResult = await sandbox.exec("claude --version", {
        timeout: 30000,
      });
      if (!cliResult.success) {
        throw new Error("Claude CLI not available in sandbox");
      }
      this.log("info", "Claude CLI verified", {
        version: cliResult.stdout.trim(),
      });

      if (!config.repoUrl) {
        await sandbox.exec(
          "mkdir -p /workspace && touch /workspace/.ciel-ready",
        );
      }

      await this.notifyRegistry("idle");
      await this.statusMessage("Agent ready");
      this.setState({ ...this.state, status: "idle" });
      this.log("info", "Provisioning complete");
    } catch (err: any) {
      this.log("error", "Provisioning failed", { error: err.message });
      this.setState({
        ...this.state,
        status: "failed",
        lastError: err.message || "Provisioning failed",
      });
      await this.notifyRegistry("failed");
      throw err;
    }
  }

  async onMessage(_connection: any, message: string | ArrayBuffer) {
    if (typeof message !== "string") return;

    try {
      const payload = JSON.parse(message);

      if (payload.type === "prompt" && payload.content) {
        if (this.state.status !== "idle") {
          await this.errorMessage(
            `Agent is ${this.state.status}. Please wait for it to become idle.`,
          );
          return;
        }
        await this.executePrompt(payload.content);
      }
    } catch (err: any) {
      this.log("error", "Message handling failed", { error: err.message });
      await this.errorMessage(`Failed to process message: ${err.message}`);
    }
  }

  private async executePrompt(prompt: string): Promise<void> {
    this.ensureTables();

    if (this.state.status !== "idle") {
      await this.errorMessage(
        "Agent is busy. Please wait for the current turn to complete.",
      );
      return;
    }

    try {
      this.setState({ ...this.state, status: "running", lastError: null });
      await this.notifyRegistry("running");

      await this.persistMessage({
        id: crypto.randomUUID(),
        type: "user",
        content: prompt,
        ts: Date.now(),
        seq: this.sequenceCounter++,
      });

      if (!this.state.agentId) {
        throw new Error("Agent ID not set. Agent must be provisioned first.");
      }
      const sandbox = getSandbox(this.env.SANDBOX, this.state.agentId);

      await this.waitForSandbox(sandbox, "Waking up container...");

      // Check if workspace needs re-provisioning (container slept, filesystem reset)
      const wsCheck = await sandbox.exec(
        "test -d /workspace/.git || test -f /workspace/.ciel-ready",
      );
      if (!wsCheck.success) {
        await this.warmupWorkspace(sandbox);
      }

      // Build environment variables (API key + optional GitHub token)
      const execEnv = this.buildEnvVars();
      if (this.state.repoUrl) {
        const registry = this.env.AGENT_REGISTRY.get(
          this.env.AGENT_REGISTRY.idFromName("default"),
        );
        // @ts-expect-error - getGitHubToken is callable
        const ghToken = await registry.getGitHubToken();
        if (ghToken) {
          execEnv.GH_TOKEN = ghToken;
        }
      }

      // Write secrets to env file (writeFile only logs path/size, not content)
      const envLines = Object.entries(execEnv)
        .map(([k, v]) => `export ${k}='${v}'`)
        .join("\n");
      await sandbox.writeFile("/tmp/ciel_env.sh", envLines);

      // Write system prompt and user prompt to files (avoids shell escaping)
      await sandbox.writeFile("/tmp/ciel_system.txt", this.buildSystemPrompt());
      await sandbox.writeFile("/tmp/ciel_prompt.txt", prompt);

      await this.statusMessage("Thinking...");

      // Execute Claude CLI directly
      // Source env file first so claude and gh inherit API keys
      // chown workspace to non-root user, then run claude as that user
      // (--dangerously-skip-permissions cannot run as root)
      const claudeCmd = [
        'source /tmp/ciel_env.sh &&',
        'git config --global credential.helper store &&',
        'printf "https://oauth2:%s@github.com\\n" "$GH_TOKEN" > ~/.git-credentials &&',
        'git config --global user.email "ciel@example.com" &&',
        'git config --global user.name "Ciel Agent" &&',
        'cd /workspace &&',
        'claude -p "$(cat /tmp/ciel_prompt.txt)"',
        '--append-system-prompt-file /tmp/ciel_system.txt',
        '--output-format stream-json',
        '--verbose',
        '--model claude-haiku-4-5-20251001',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
      ].join(' ');
      const command = `chown -R ciel:ciel /workspace /tmp/ciel_env.sh /tmp/ciel_system.txt /tmp/ciel_prompt.txt && runuser -u ciel -- bash -c '${claudeCmd}'`;

      const stream = await sandbox.execStream(command, { timeout: 600000 });
      await this.processStream(stream);

      this.setState({ ...this.state, status: "idle" });
      await this.notifyRegistry("idle");
    } catch (err: any) {
      this.log("error", "Prompt execution failed", { error: err.message });

      try {
        if (this.state.agentId) {
          const sandbox = getSandbox(this.env.SANDBOX, this.state.agentId);
          await sandbox.killAllProcesses();
        }
      } catch (cleanupErr) {
        this.log("warn", "Cleanup failed after error", { error: cleanupErr });
      }

      this.setState({
        ...this.state,
        status: "failed",
        lastError: err.message || "Execution failed",
      });
      await this.notifyRegistry("failed");
      await this.errorMessage(`Execution failed: ${err.message}`);
    }
  }

  private buildSystemPrompt(): string {
    let prompt = `You are a coding agent working in /workspace.
Do not use todo list tools - respond directly to the user in chat instead.
`;

    if (this.state.repoUrl) {
      if (this.state.branch) {
        prompt += `
## Git Workflow

You are working on branch: ${this.state.branch} in a cloned GitHub repository.
Repository URL: ${this.state.repoUrl}

The git remote is already configured with authentication - you can push directly.

**Autonomous Git Workflow:**
When you complete a task or make changes:
1. Stage your changes: \`git add <files>\`
2. Commit with a descriptive message: \`git commit -m "Brief description of changes"\`
3. Push to GitHub: \`git push origin ${this.state.branch}\` (use \`-u\` flag on first push)
4. Create a PR automatically: \`gh pr create --title "Brief title" --body "What changed and why" --base main\`

**IMPORTANT: After successfully completing any user request that modifies files, you should automatically:**
- Commit the changes with a clear message
- Push to GitHub
- Create a pull request (unless one already exists for this branch)
- Tell the user the PR URL

You don't need to ask permission - just do it as part of completing the task.

Check for existing PRs first: \`gh pr list --head ${this.state.branch}\`
If a PR already exists, just push the new commits to it.
`;
      } else {
        prompt += `
## Git Workflow

You are working in a cloned GitHub repository.
Repository URL: ${this.state.repoUrl}

**First Task: Create Your Working Branch**
Before making any changes:
1. Check current branch: \`git branch --show-current\`
2. Create a descriptive branch: \`git checkout -b ciel/brief-task-description\`

**Autonomous Git Workflow:**
After creating your branch and completing work:
1. Stage your changes: \`git add <files>\`
2. Commit with a descriptive message: \`git commit -m "Brief description of changes"\`
3. Push to GitHub: \`git push -u origin ciel/your-branch-name\`
4. Create a PR: \`gh pr create --title "Brief title" --body "What changed and why" --base main\`

**IMPORTANT: After successfully completing any user request that modifies files, you should automatically:**
- Create a descriptive branch if you haven't already
- Commit the changes with a clear message
- Push to GitHub
- Create a pull request
- Tell the user the PR URL and branch name

You don't need to ask permission - just do it as part of completing the task.
`;
      }
    } else {
      prompt += `
## Git Workflow

You are NOT working in a GitHub repository. Git operations are not available.
If the user asks to push changes to GitHub, explain that this agent wasn't created with a repository.
`;
    }

    // Inject conversation history for context continuity
    const history = this.getRecentHistory();
    if (history.length > 0) {
      prompt += "\n## Previous Conversation\n\n";
      for (const msg of history) {
        if (msg.type === "user") {
          prompt += `User: ${msg.content}\n`;
        } else if (msg.type === "assistant_text") {
          prompt += `Assistant: ${msg.content}\n`;
        } else if (msg.type === "tool_use") {
          prompt += `[Used tool: ${msg.metadata?.name || "unknown"}]\n`;
        } else if (msg.type === "tool_result") {
          prompt += "[Tool result received]\n";
        }
      }
      prompt += "\n## Current Request\n\n";
    }

    return prompt;
  }

  private getRecentHistory(): ChatMessage[] {
    return this.state.messages
      .filter((m) =>
        ["user", "assistant_text", "tool_use", "tool_result"].includes(m.type),
      )
      .slice(-20);
  }

  private buildEnvVars(): Record<string, string> {
    const envVars: Record<string, string> = {};

    if (this.env.ANTHROPIC_AUTH_TOKEN) {
      envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_AUTH_TOKEN;
    } else if (this.env.ANTHROPIC_API_KEY) {
      envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
    } else {
      throw new Error(
        "No API key configured. Set either ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN.",
      );
    }

    if (this.env.ANTHROPIC_BASE_URL) {
      envVars.ANTHROPIC_BASE_URL = this.env.ANTHROPIC_BASE_URL;
    }

    return envVars;
  }

  private async processStream(stream: ReadableStream): Promise<void> {
    const abortController = new AbortController();
    let streamTimeout: ReturnType<typeof setTimeout> | null = null;

    const resetTimeout = () => {
      if (streamTimeout) clearTimeout(streamTimeout);
      streamTimeout = setTimeout(() => {
        this.log(
          "error",
          "Stream timeout - no events received for 120 seconds",
        );
        abortController.abort();
      }, 120000);
    };

    resetTimeout();

    try {
      for await (const event of parseSSEStream<ExecEvent>(
        stream,
        abortController.signal,
      )) {
        resetTimeout();

        if (event.type === "stdout" && event.data) {
          const lines = event.data.split("\n").filter((l) => l.trim());
          for (const line of lines) {
            try {
              const msg = JSON.parse(line);
              await this.handleClaudeMessage(msg);
            } catch {
              this.log("debug", "Non-JSON stdout line", {
                line: line.slice(0, 200),
              });
            }
          }
        } else if (event.type === "stderr" && event.data) {
          this.log("debug", "claude stderr", { data: event.data });
        } else if (event.type === "complete") {
          if (event.exitCode !== 0) {
            throw new Error(`Claude CLI exited with code ${event.exitCode}`);
          }
        } else if (event.type === "error") {
          throw new Error(`Runtime error: ${event.error}`);
        }
      }
    } catch (streamErr: any) {
      if (streamErr.name === "AbortError") {
        throw new Error(
          "Stream timeout: Claude CLI did not produce output within 120 seconds",
        );
      }
      throw streamErr;
    } finally {
      if (streamTimeout) clearTimeout(streamTimeout);
      try {
        abortController.abort();
      } catch {
        // Already aborted
      }
    }
  }

  private async handleClaudeMessage(msg: any): Promise<void> {
    if (msg.type === "system") {
      if (msg.subtype === "init") {
        this.log("info", "Claude session started", {
          session_id: msg.session_id,
          model: msg.model,
        });
      }
      return;
    }

    if (msg.type === "assistant") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === "text" && block.text) {
          await this.persistMessage({
            id: crypto.randomUUID(),
            type: "assistant_text",
            content: block.text,
            ts: Date.now(),
            seq: this.sequenceCounter++,
          });
        } else if (block.type === "tool_use") {
          await this.persistMessage({
            id: crypto.randomUUID(),
            type: "tool_use",
            content: `Using tool: ${block.name}`,
            ts: Date.now(),
            seq: this.sequenceCounter++,
            metadata: {
              name: block.name,
              input: block.input,
              tool_use_id: block.id,
            },
          });
        } else if (block.type === "thinking" && block.thinking) {
          await this.persistMessage({
            id: crypto.randomUUID(),
            type: "thinking",
            content: block.thinking,
            ts: Date.now(),
            seq: this.sequenceCounter++,
          });
        }
      }
      return;
    }

    if (msg.type === "user") {
      const content = msg.message?.content;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === "tool_result") {
          let resultContent: string;
          if (typeof block.content === "string") {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .map((c: any) => c.text || JSON.stringify(c))
              .join("\n");
          } else {
            resultContent = JSON.stringify(block.content ?? "");
          }

          if (resultContent.length > 1000) {
            resultContent = resultContent.slice(0, 1000) + "... (truncated)";
          }

          await this.persistMessage({
            id: crypto.randomUUID(),
            type: "tool_result",
            content: resultContent,
            ts: Date.now(),
            seq: this.sequenceCounter++,
            metadata: {
              tool_use_id: block.tool_use_id,
              is_error: block.is_error || false,
            },
          });
        }
      }
      return;
    }

    if (msg.type === "result") {
      const totalCost = msg.total_cost_usd || 0;

      await this.persistMessage({
        id: crypto.randomUUID(),
        type: "result",
        content: msg.is_error
          ? `Error: ${msg.result || "Unknown error"}`
          : "Query complete",
        ts: Date.now(),
        seq: this.sequenceCounter++,
        metadata: {
          total_cost_usd: totalCost,
          duration_ms: msg.duration_ms || 0,
          num_turns: msg.num_turns,
        },
      });

      if (totalCost > 0) {
        const newCost = this.state.totalCostUsd + totalCost;
        this.setState({ ...this.state, totalCostUsd: newCost });
        await this.notifyRegistry("idle", { totalCostUsd: newCost });
      }
      return;
    }
  }

  // --- Sandbox lifecycle helpers ---

  private async waitForSandbox(
    sandbox: ReturnType<typeof getSandbox>,
    statusMsg: string,
  ): Promise<void> {
    let retries = 0;
    const maxRetries = 150;
    let notifiedUser = false;

    while (retries < maxRetries) {
      try {
        const healthCheck = await sandbox.exec("echo ready", { timeout: 3000 });
        if (healthCheck.success) return;
      } catch {
        if (!notifiedUser) {
          notifiedUser = true;
          await this.statusMessage(statusMsg);
        } else if (retries > 0 && retries % 15 === 0) {
          const elapsed = retries * 2;
          await this.statusMessage(
            `${statusMsg} (${Math.floor(elapsed / 60)}m${elapsed % 60}s elapsed)`,
          );
        }
      }
      retries++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Sandbox failed to become ready after 5 minutes");
  }

  private async cloneRepo(
    sandbox: ReturnType<typeof getSandbox>,
    repoUrl: string,
  ): Promise<void> {
    await this.statusMessage("Fetching GitHub token...");

    const registry = this.env.AGENT_REGISTRY.get(
      this.env.AGENT_REGISTRY.idFromName("default"),
    );
    // @ts-expect-error - getGitHubToken is callable
    const token = await registry.getGitHubToken();

    if (!token) {
      throw new Error(
        "GitHub token not configured. Please set up your GitHub token first.",
      );
    }

    if (
      !/^https:\/\/github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(
        repoUrl,
      )
    ) {
      throw new Error("Invalid repository URL format");
    }

    await this.statusMessage("Cloning repository...");

    await sandbox.exec(
      `git config --global credential.helper store && printf "https://oauth2:%s@github.com\\n" "$GH_TOKEN" > ~/.git-credentials`,
      { timeout: 10000, env: { GH_TOKEN: token } },
    );

    const cloneResult = await sandbox.exec(
      `git clone ${repoUrl} /workspace && cd /workspace && git config user.email "ciel@example.com" && git config user.name "Ciel Agent"`,
      { timeout: 300000 },
    );

    if (!cloneResult.success) {
      if (
        cloneResult.stderr.includes("Authentication failed") ||
        cloneResult.stderr.includes("could not read Username")
      ) {
        throw new Error("Authentication failed - check your GitHub token");
      }
      throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
    }
  }

  private async warmupWorkspace(
    sandbox: ReturnType<typeof getSandbox>,
  ): Promise<void> {
    await this.statusMessage("Warming up sandbox...");
    await sandbox.exec("cd / && rm -rf /workspace");

    if (this.state.repoUrl) {
      await this.statusMessage("Re-cloning repository...");
      const registry = this.env.AGENT_REGISTRY.get(
        this.env.AGENT_REGISTRY.idFromName("default"),
      );
      // @ts-expect-error - getGitHubToken is callable
      const token = await registry.getGitHubToken();

      if (token) {
        await sandbox.exec(
          `git config --global credential.helper store && printf "https://oauth2:%s@github.com\\n" "$GH_TOKEN" > ~/.git-credentials`,
          { env: { GH_TOKEN: token } },
        );
        const cloneResult = await sandbox.exec(
          `git clone ${this.state.repoUrl} /workspace`,
          { timeout: 300000 },
        );
        if (!cloneResult.success) {
          throw new Error(
            `Failed to re-clone repository: ${cloneResult.stderr}`,
          );
        }
      } else {
        throw new Error(
          "GitHub token not available. Cannot re-clone repository after sandbox wake-up.",
        );
      }
    } else {
      await sandbox.exec(
        "mkdir -p /workspace && touch /workspace/.ciel-ready",
      );
    }
  }

  // --- Message persistence ---

  private async persistMessage(msg: ChatMessage): Promise<void> {
    try {
      const metadataJson = msg.metadata ? JSON.stringify(msg.metadata) : null;
      this.sql`
        INSERT INTO messages (id, seq, type, content, metadata_json, created_at)
        VALUES (${msg.id}, ${msg.seq}, ${msg.type}, ${msg.content}, ${metadataJson}, ${msg.ts})
      `;
    } catch (err) {
      console.warn(`Failed to persist message: ${msg.type}`, err);
    }

    const updatedMessages = [...this.state.messages, msg].slice(-50);
    this.setState({ ...this.state, messages: updatedMessages });
  }

  private async statusMessage(content: string): Promise<void> {
    await this.persistMessage({
      id: crypto.randomUUID(),
      type: "status",
      content,
      ts: Date.now(),
      seq: this.sequenceCounter++,
    });
  }

  private async errorMessage(content: string): Promise<void> {
    await this.persistMessage({
      id: crypto.randomUUID(),
      type: "error",
      content,
      ts: Date.now(),
      seq: this.sequenceCounter++,
    });
  }

  private async notifyRegistry(
    status: string,
    metadata?: { totalCostUsd?: number },
  ): Promise<void> {
    try {
      const registry = this.env.AGENT_REGISTRY.get(
        this.env.AGENT_REGISTRY.idFromName("default"),
      );
      // @ts-expect-error - updateAgentStatus is callable
      await registry.updateAgentStatus(this.state.agentId, status, metadata);
    } catch (err: any) {
      this.log("warn", "Failed to notify registry", { error: err.message });
    }
  }

  private log(level: string, message: string, context?: any): void {
    try {
      const contextJson = context ? JSON.stringify(context) : null;
      this.sql`
        INSERT INTO logs (level, message, context_json, created_at)
        VALUES (${level}, ${message}, ${contextJson}, ${Date.now()})
      `;
    } catch (err) {
      console.warn(`Failed to log: ${message}`, err);
    }
  }

  // --- HTTP endpoints ---

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: this.state.status,
        messageCount: this.state.messages.length,
        totalCostUsd: this.state.totalCostUsd,
      });
    }

    if (url.pathname === "/history") {
      const limit = parseInt(url.searchParams.get("limit") || "100");
      const offset = parseInt(url.searchParams.get("offset") || "0");

      const rows = this.sql<{
        id: string;
        seq: number;
        type: string;
        content: string;
        metadata_json: string | null;
        created_at: number;
      }>`SELECT * FROM messages ORDER BY seq ASC LIMIT ${limit} OFFSET ${offset}`;

      return Response.json({
        messages: rows.map((r) => ({
          id: r.id,
          type: r.type,
          content: r.content,
          ts: r.created_at,
          seq: r.seq,
          metadata: r.metadata_json ? JSON.parse(r.metadata_json) : undefined,
        })),
      });
    }

    return new Response("Not found", { status: 404 });
  }

  @callable({ description: "Destroy agent and cleanup resources" })
  async destroy(): Promise<void> {
    try {
      if (this.state.agentId) {
        const sandbox = getSandbox(this.env.SANDBOX, this.state.agentId);
        try {
          await sandbox.killAllProcesses();
          await sandbox.destroy();
        } catch (sandboxErr: any) {
          this.log("warn", "Failed to cleanup sandbox", {
            error: sandboxErr.message,
          });
        }
      }
    } catch (err: any) {
      this.log("warn", "Destroy cleanup warning", { error: err.message });
    }
  }
}
