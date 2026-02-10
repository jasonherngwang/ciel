import { Badge } from "./ui/badge";
import { Loader2 } from "lucide-react";

interface StatusBadgeProps {
  status: string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const variants: Record<string, { variant: any; label: string; animate?: boolean }> = {
    idle: { variant: "default", label: "Idle" },
    running: { variant: "default", label: "Running", animate: true },
    provisioning: { variant: "secondary", label: "Provisioning" },
    failed: { variant: "destructive", label: "Failed" },
  };

  const config = variants[status] || { variant: "outline", label: status };

  return (
    <Badge variant={config.variant} className="flex items-center gap-1">
      {config.animate && <Loader2 className="h-3 w-3 animate-spin" />}
      {config.label}
    </Badge>
  );
}
