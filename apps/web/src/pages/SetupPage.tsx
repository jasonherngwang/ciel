import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { XCircle } from "lucide-react";

export function SetupPage() {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const registry = useAgent({
    agent: "AgentRegistry",
    name: "default",
  }) as any;

  const handleSave = async () => {
    if (!token.trim()) {
      setError("Please enter a GitHub token");
      return;
    }

    try {
      setSaving(true);
      setError(null);

      await registry.call("setGitHubToken", [token.trim()]);

      navigate({ to: "/" });
    } catch (err: any) {
      setError(err.message || "Failed to save token");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-16 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>GitHub Token Setup</CardTitle>
          <CardDescription>
            Configure your GitHub Personal Access Token to clone and interact with repositories.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Personal Access Token</label>
            <Textarea
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_..."
              rows={3}
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Create a token at{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                github.com/settings/tokens
              </a>{" "}
              with <code className="text-xs">repo</code> scope.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <XCircle className="h-4 w-4" />
              {error}
            </div>
          )}
        </CardContent>
        <CardFooter className="flex justify-between">
          <Button variant="outline" onClick={() => navigate({ to: "/" })}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Token"}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
