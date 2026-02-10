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

      // Save the token
      await registry.call("setGitHubToken", [token.trim()]);

      // Test the token by trying to list repos
      const result = await registry.call("listGitHubRepos", []);

      if (result.error) {
        setError(
          result.message ||
          "Token saved but validation failed. Please check your token has the required permissions."
        );
        return;
      }

      // Success - navigate to home
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
              placeholder="github_pat_..."
              rows={3}
              className="font-mono text-sm"
            />
            <div className="text-xs text-muted-foreground space-y-2">
              <p>
                Create a <strong>fine-grained personal access token</strong> at{" "}
                <a
                  href="https://github.com/settings/personal-access-tokens/new"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  github.com/settings/personal-access-tokens/new
                </a>
              </p>
              <div className="border-l-2 border-yellow-500 pl-3 py-1 bg-yellow-50 dark:bg-yellow-950/20">
                <p className="font-semibold">Important Setup Steps:</p>
                <ol className="list-decimal list-inside pl-2 space-y-1 mt-1">
                  <li><strong>Repository access:</strong> Select "Only select repositories" and choose the repos you want agents to work on (or "All repositories" for full access)</li>
                  <li><strong>Repository permissions:</strong>
                    <ul className="list-disc list-inside pl-6 mt-1">
                      <li><strong>Contents:</strong> <span className="text-red-600 dark:text-red-400 font-bold">Read and write</span> (NOT just Read)</li>
                      <li><strong>Metadata:</strong> Read-only (mandatory)</li>
                      <li><strong>Pull requests:</strong> <span className="text-red-600 dark:text-red-400 font-bold">Read and write</span> (NOT just Read)</li>
                    </ul>
                  </li>
                </ol>
              </div>
              <p className="text-red-600 dark:text-red-400 font-bold">
                ⚠️ CRITICAL: You must grant WRITE access to both Contents and Pull requests. Read-only tokens will not work.
              </p>
            </div>
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
