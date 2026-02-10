import { useState, useEffect } from "react";
import { useAgent } from "agents/react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Alert, AlertDescription } from "./ui/alert";
import { XCircle, Loader2 } from "lucide-react";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface GitHubRepo {
  name: string;
  full_name: string;
  private: boolean;
}

export function CreateAgentDialog({ open, onOpenChange }: CreateAgentDialogProps) {
  const [name, setName] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registry = useAgent({
    agent: "AgentRegistry",
    name: "default",
  }) as any;

  useEffect(() => {
    if (open) {
      // Fetch repos when dialog opens
      fetchRepos();
    } else {
      // Reset state when closing
      setName("");
      setSelectedRepo("");
      setError(null);
    }
  }, [open]);

  const fetchRepos = async () => {
    try {
      setLoadingRepos(true);
      setError(null);
      const result = await registry.call("listGitHubRepos", []);

      if (result.error === "token_missing") {
        setError("GitHub token not configured. Please set up your token at /setup first.");
      } else if (result.error === "token_invalid") {
        setError(result.message || "GitHub token is invalid. Please update your token at /setup.");
      } else if (result.error) {
        setError(result.message || `Failed to fetch repositories: ${result.error}`);
      } else if (result.repos) {
        setRepos(result.repos);
        if (result.message) {
          setError(result.message); // Warning message for 0 repos
        }
      }
    } catch (err: any) {
      setError(err.message || "Failed to fetch repositories");
    } finally {
      setLoadingRepos(false);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Agent name is required");
      return;
    }

    if (!selectedRepo) {
      setError("Repository is required");
      return;
    }

    try {
      setCreating(true);
      setError(null);

      const config = {
        name: name.trim(),
        repoUrl: `https://github.com/${selectedRepo}`,
      };

      // Create agent via registry
      await registry.call("createAgent", [config]);

      onOpenChange(false);
    } catch (err: any) {
      setError(err.message || "Failed to create agent");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create New Agent</DialogTitle>
          <DialogDescription>
            Create a new coding agent connected to a GitHub repository.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Agent Name *</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-agent"
              disabled={creating || loadingRepos}
            />
            <p className="text-xs text-muted-foreground">
              Alphanumeric characters and hyphens only
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="repo">GitHub Repository *</Label>
            {loadingRepos ? (
              <div className="flex items-center gap-2 p-2 border rounded-md text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading repositories...
              </div>
            ) : repos.length === 0 ? (
              <Alert>
                <AlertDescription>
                  {error || "No repositories found. Make sure your GitHub token is configured."}
                </AlertDescription>
              </Alert>
            ) : (
              <select
                id="repo"
                value={selectedRepo}
                onChange={(e) => setSelectedRepo(e.target.value)}
                disabled={creating}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">Select a repository...</option>
                {repos.map((repo) => (
                  <option key={repo.full_name} value={repo.full_name}>
                    {repo.full_name} {repo.private ? "🔒" : ""}
                  </option>
                ))}
              </select>
            )}
            <p className="text-xs text-muted-foreground">
              Agent will create its own branch based on the task (e.g., <code className="font-mono">ciel/add-feature</code>)
            </p>
          </div>

          {error && !loadingRepos && repos.length > 0 && (
            <Alert variant="destructive">
              <XCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating || loadingRepos || repos.length === 0 || !name.trim() || !selectedRepo}
          >
            {creating ? "Creating..." : "Create Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
