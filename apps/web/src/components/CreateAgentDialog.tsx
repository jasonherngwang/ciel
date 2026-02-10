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
import { XCircle } from "lucide-react";

interface CreateAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateAgentDialog({ open, onOpenChange }: CreateAgentDialogProps) {
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const registry = useAgent({
    agent: "AgentRegistry",
    name: "default",
  }) as any;

  useEffect(() => {
    if (!open) {
      setName("");
      setRepoUrl("");
      setBranch("main");
      setError(null);
    }
  }, [open]);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError("Agent name is required");
      return;
    }

    try {
      setCreating(true);
      setError(null);

      const config = {
        name: name.trim(),
        repoUrl: repoUrl.trim() || undefined,
        branch: branch.trim() || undefined,
      };

      // Create agent via registry
      await registry.call("createAgent", [config]);

      // Provision the new agent - but we can't easily get a connection to it
      // The agent will show as "provisioning" in the dashboard
      // For now, skip the provision call - it will need to be triggered from the UI after creation

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
            Configure a new coding agent. You can optionally connect it to a GitHub repository.
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
              disabled={creating}
            />
            <p className="text-xs text-muted-foreground">
              Alphanumeric characters and hyphens only
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="repoUrl">Repository URL (optional)</Label>
            <Input
              id="repoUrl"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/user/repo"
              disabled={creating}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="branch">Branch</Label>
            <Input
              id="branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              disabled={creating}
            />
          </div>

          {error && (
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
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
