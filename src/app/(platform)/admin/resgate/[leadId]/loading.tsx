import { UserCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export default function AdminRescueLeadDetailLoading() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={UserCheck}
        title="Detalhes do lead"
        description="Carregando informações do lead..."
        help="admin.resgateDetalhe"
      />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card className="border-border bg-surface p-6">
          <Skeleton className="h-6 w-48 mb-4" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Card>
        <Card className="border-border bg-surface p-6">
          <Skeleton className="h-6 w-48 mb-4" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        </Card>
      </div>
      <Card className="border-border bg-surface p-6">
        <Skeleton className="h-6 w-56 mb-4" />
        <Skeleton className="h-24 w-full" />
      </Card>
    </div>
  );
}
