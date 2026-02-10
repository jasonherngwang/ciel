import { Agent, unstable_callable as callable } from "agents";
import type { Env, RegistryState, AgentConfig, AgentMetadata } from "./types";

export class AgentRegistry extends Agent<Env, RegistryState> {
  initialState: RegistryState = { agents: [] };

  async onStart() {
    // Create tables (WAL mode is managed automatically by Agents SDK)
    this.sql`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        repo_url TEXT,
        branch TEXT,
        status TEXT NOT NULL DEFAULT 'provisioning',
        total_cost_usd REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `;

    this.sql`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    // Load agents from SQLite into state
    const rows = this.sql<{
      id: string;
      name: string;
      repo_url: string | null;
      branch: string | null;
      status: string;
      total_cost_usd: number;
      created_at: number;
      updated_at: number;
    }>`SELECT * FROM agents ORDER BY created_at DESC`;

    this.setState({
      agents: rows.map((row) => ({
        id: row.id,
        name: row.name,
        repoUrl: row.repo_url,
        branch: row.branch,
        status: row.status,
        totalCostUsd: row.total_cost_usd,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  }

  @callable({ description: "Create a new agent" })
  async createAgent(config: AgentConfig): Promise<AgentMetadata> {
    // Validate agent name
    if (!config.name || typeof config.name !== "string") {
      throw new Error("Agent name is required");
    }

    const name = config.name.trim();
    if (!/^[a-zA-Z0-9-]+$/.test(name)) {
      throw new Error(
        "Agent name must contain only alphanumeric characters and hyphens"
      );
    }

    if (name.length < 1 || name.length > 64) {
      throw new Error("Agent name must be between 1 and 64 characters");
    }

    // Check uniqueness (case-insensitive)
    const existing = this.sql<{ count: number }>`
      SELECT COUNT(*) as count FROM agents WHERE LOWER(name) = LOWER(${name})
    `;

    if (existing.length > 0 && existing[0].count > 0) {
      throw new Error(`Agent name "${name}" is already taken`);
    }

    // Create agent metadata
    const id = crypto.randomUUID();
    const now = Date.now();
    const metadata: AgentMetadata = {
      id,
      name,
      repoUrl: config.repoUrl || null,
      branch: config.branch || null,
      status: "provisioning",
      totalCostUsd: 0,
      createdAt: now,
      updatedAt: now,
    };

    // Insert into SQLite
    this.sql`
      INSERT INTO agents (id, name, repo_url, branch, status, total_cost_usd, created_at, updated_at)
      VALUES (
        ${metadata.id},
        ${metadata.name},
        ${metadata.repoUrl},
        ${metadata.branch},
        ${metadata.status},
        ${metadata.totalCostUsd},
        ${metadata.createdAt},
        ${metadata.updatedAt}
      )
    `;

    // Update state (triggers broadcast to all connected clients)
    this.setState({
      agents: [metadata, ...this.state.agents],
    });

    // Trigger provisioning on CielAgent DO (fire and forget - CielAgent will update status)
    const agentStub = this.env.CIEL_AGENT.get(this.env.CIEL_AGENT.idFromName(id));
    // @ts-expect-error - provision is a callable method defined in CielAgent
    agentStub.provision({ ...config, agentId: id }).catch((err: any) => {
      console.error(`Failed to provision agent ${id}:`, err);
      // CielAgent will call notifyRegistry to update status, so we don't need to do it here
    });

    return metadata;
  }

  @callable({ description: "Delete an agent" })
  async deleteAgent(id: string): Promise<void> {
    // Remove from SQLite
    this.sql`DELETE FROM agents WHERE id = ${id}`;

    // Update state
    this.setState({
      agents: this.state.agents.filter((a) => a.id !== id),
    });

    // Best-effort: call destroy() on CielAgent DO
    try {
      const agentStub = this.env.CIEL_AGENT.get(
        this.env.CIEL_AGENT.idFromName(id)
      );
      // @ts-expect-error - destroy is a callable method defined in CielAgent
      await agentStub.destroy();
    } catch (err) {
      // DO may already be evicted or destroyed - ignore
      console.warn(`Failed to destroy CielAgent ${id}:`, err);
    }
  }

  @callable({ description: "Update agent status and metadata" })
  async updateAgentStatus(
    id: string,
    status: string,
    metadata?: Partial<{
      totalCostUsd: number;
      lastError: string | null;
    }>
  ): Promise<void> {
    const now = Date.now();

    if (metadata?.totalCostUsd !== undefined) {
      this.sql`
        UPDATE agents
        SET status = ${status},
            updated_at = ${now},
            total_cost_usd = ${metadata.totalCostUsd}
        WHERE id = ${id}
      `;
    } else {
      this.sql`
        UPDATE agents
        SET status = ${status},
            updated_at = ${now}
        WHERE id = ${id}
      `;
    }

    // Update state
    const updatedAgents = this.state.agents.map((a) =>
      a.id === id
        ? {
            ...a,
            status,
            updatedAt: now,
            ...(metadata?.totalCostUsd !== undefined && {
              totalCostUsd: metadata.totalCostUsd,
            }),
          }
        : a
    );

    this.setState({ agents: updatedAgents });
  }

  @callable({ description: "List all agents" })
  async listAgents(filter?: { status?: string }): Promise<AgentMetadata[]> {
    if (!filter?.status) {
      return this.state.agents;
    }

    return this.state.agents.filter((a) => a.status === filter.status);
  }

  @callable({ description: "Get decrypted GitHub token (internal use only)" })
  async getGitHubToken(): Promise<string | null> {
    const rows = this.sql<{ value: string }>`
      SELECT value FROM settings WHERE key = 'github_token'
    `;

    if (rows.length === 0) return null;

    // Decrypt token
    return await this.decryptToken(rows[0].value);
  }

  @callable({ description: "Set encrypted GitHub token" })
  async setGitHubToken(token: string): Promise<void> {
    // Encrypt token
    const encrypted = await this.encryptToken(token);

    // Upsert into settings
    this.sql`
      INSERT INTO settings (key, value) VALUES ('github_token', ${encrypted})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  }

  @callable({ description: "List GitHub repositories using stored token" })
  async listGitHubRepos(): Promise<
    { error?: string; repos?: Array<{ name: string; full_name: string; private: boolean }>; message?: string }
  > {
    const token = await this.getGitHubToken();

    if (!token) {
      return { error: "token_missing" };
    }

    try {
      // First, check if this is a fine-grained PAT by checking token format
      const isFineGrained = token.startsWith("github_pat_");

      let repos: Array<{ name: string; full_name: string; private: boolean }> = [];

      if (isFineGrained) {
        // For fine-grained PATs, we need to filter repos by what the token can access
        // Try to get accessible repos through the user endpoint
        const response = await fetch("https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Ciel-Agent/1.0",
          },
        });

        if (response.status === 401) {
          this.sql`DELETE FROM settings WHERE key = 'github_token'`;
          return { error: "token_invalid", message: "Token authentication failed. Please create a new token." };
        }

        if (response.status === 403) {
          return this.handleForbiddenResponse(response);
        }

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`GitHub API error ${response.status}:`, errorText);
          return { error: `github_error_${response.status}`, message: `GitHub API returned ${response.status}` };
        }

        const allRepos = await response.json() as Array<{ name: string; full_name: string; private: boolean }>;

        // For fine-grained PATs, filter by testing access to each repo
        // We'll test by trying to get the repo details
        for (const repo of allRepos) {
          const accessCheck = await fetch(`https://api.github.com/repos/${repo.full_name}`, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "Ciel-Agent/1.0",
            },
          });

          // If we can access it, include it
          if (accessCheck.ok) {
            repos.push(repo);
          }
        }
      } else {
        // Classic PAT - just use the standard endpoint
        const response = await fetch("https://api.github.com/user/repos?per_page=100&affiliation=owner,collaborator", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Ciel-Agent/1.0",
          },
        });

        if (response.status === 401) {
          this.sql`DELETE FROM settings WHERE key = 'github_token'`;
          return { error: "token_invalid", message: "Token authentication failed. Please create a new token." };
        }

        if (response.status === 403) {
          return this.handleForbiddenResponse(response);
        }

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`GitHub API error ${response.status}:`, errorText);
          return { error: `github_error_${response.status}`, message: `GitHub API returned ${response.status}` };
        }

        repos = await response.json() as Array<{ name: string; full_name: string; private: boolean }>;
      }

      if (repos.length === 0) {
        return {
          repos: [],
          message: "No repositories found. Make sure your token has access to at least one repository."
        };
      }

      return { repos };
    } catch (err: any) {
      console.error("Network error fetching repos:", err);
      return { error: "network_error", message: err.message };
    }
  }

  private async handleForbiddenResponse(response: Response): Promise<{ error: string; message: string }> {
    let errorMessage = "Token lacks required permissions.";
    const contentType = response.headers.get("content-type");

    if (contentType?.includes("application/json")) {
      try {
        const errorData = await response.json() as any;
        console.error("GitHub API 403:", errorData);
        if (errorData.message) {
          errorMessage = errorData.message;
        }
      } catch (e) {
        console.error("Failed to parse 403 response as JSON:", e);
      }
    } else {
      // GitHub returned HTML or plain text (common with permission errors)
      const text = await response.text();
      console.error("GitHub API 403 (non-JSON):", text.substring(0, 200));
    }

    return {
      error: "token_invalid",
      message: "Token lacks required permissions. Your token needs WRITE access to Contents and Pull requests."
    };
  }

  onStateChanged() {
    // Filter sensitive data before syncing to clients
    // (GitHub token is not in state, so nothing to filter for MVP)
  }

  // Encryption helpers using Web Crypto API (AES-GCM)
  private async encryptToken(plaintext: string): Promise<string> {
    const key = await this.getCryptoKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      data
    );

    // Return as "iv:ciphertext" (both base64)
    const ivB64 = btoa(String.fromCharCode(...iv));
    const ciphertextB64 = btoa(
      String.fromCharCode(...new Uint8Array(ciphertext))
    );
    return `${ivB64}:${ciphertextB64}`;
  }

  private async decryptToken(encrypted: string): Promise<string> {
    const [ivB64, ciphertextB64] = encrypted.split(":");
    if (!ivB64 || !ciphertextB64) {
      throw new Error("Invalid encrypted token format");
    }

    const key = await this.getCryptoKey();
    const iv = Uint8Array.from(atob(ivB64), (c) => c.charCodeAt(0));
    const ciphertext = Uint8Array.from(atob(ciphertextB64), (c) =>
      c.charCodeAt(0)
    );

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(plaintext);
  }

  private async getCryptoKey(): Promise<CryptoKey> {
    const keyHex = this.env.ENCRYPTION_KEY;
    if (!keyHex || keyHex.length !== 64) {
      throw new Error(
        "ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256)"
      );
    }

    // Convert hex string to Uint8Array
    const keyBytes = new Uint8Array(
      keyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    return await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  }
}
