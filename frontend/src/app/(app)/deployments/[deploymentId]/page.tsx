"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  BrainCircuit,
  Gauge,
  LayoutDashboard,
  Play,
  Radar,
  Settings2,
  Tags,
  Workflow,
} from "lucide-react";

import { SectionCard, SeverityBadge, StatusBadge } from "@/components/common";
import { DeploymentDriftPanel } from "@/components/deployment-drift";
import { DeploymentOverviewPanel } from "@/components/deployment-overview";
import { DeploymentPlaygroundPanel } from "@/components/deployment-playground";
import { DeploymentPredictionsPanel } from "@/components/deployment-predictions";
import { DeploymentRetrainingPanel } from "@/components/deployment-retraining";
import { DeploymentSettingsPanel } from "@/components/deployment-settings";
import {
  Badge,
  Button,
  ErrorState,
  LoadingBlock,
  PageHeader,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { useDeployment } from "@/lib/hooks";
import { errorMessage, fmtRelative, titleCase } from "@/lib/utils";

type TabKey = "overview" | "playground" | "predictions" | "retraining" | "drift" | "settings";

const TABS: Array<{ key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "playground", label: "Playground", icon: Play },
  { key: "predictions", label: "Predictions & labels", icon: Tags },
  { key: "retraining", label: "Retraining", icon: Workflow },
  { key: "drift", label: "Drift", icon: Radar },
  { key: "settings", label: "Settings", icon: Settings2 },
];

export default function DeploymentDetailPage() {
  const params = useParams<{ deploymentId: string }>();
  const deploymentId = params?.deploymentId;
  const [tab, setTab] = React.useState<TabKey>("overview");
  const { data: deployment, isLoading, error, refetch } = useDeployment(deploymentId);

  if (isLoading) return <LoadingBlock label="Loading deployment…" />;
  if (error) return <ErrorState message={errorMessage(error)} onRetry={() => refetch()} />;
  if (!deployment) return null;

  return (
    <div className="space-y-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-muted-foreground">
          <Link href="/deployments">
            <ArrowLeft /> Deployments
          </Link>
        </Button>
        <PageHeader
          eyebrow={
            <span className="flex flex-wrap items-center gap-1.5">
              <Link href={`/projects/${deployment.project_id}`} className="hover:text-foreground hover:underline">
                {deployment.project_name}
              </Link>
              <span>/</span>
              <span>Deployment</span>
            </span>
          }
          title={deployment.name}
          description={
            deployment.description || "Authenticated prediction endpoint with monitoring, drift, explainability, and approval-gated retraining."
          }
          actions={
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={`/monitoring?deployment=${deployment.id}`}>
                  <Activity /> Monitoring
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href={`/explainability?deployment=${deployment.id}`}>
                  <BrainCircuit /> Explainability
                </Link>
              </Button>
              <Button size="sm" onClick={() => setTab("playground")}>
                <Play /> Predict
              </Button>
            </>
          }
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <StatusBadge status={deployment.status} />
          <StatusBadge status={deployment.last_health_status} label={deployment.last_health_status ? titleCase(deployment.last_health_status) : "No health check"} />
          <Badge tone="muted">
            {deployment.model_name} v{deployment.model_version}
          </Badge>
          <Badge tone="muted">{deployment.prediction_count.toLocaleString()} predictions</Badge>
          <span className="font-mono text-[10px]">{deployment.slug}</span>
          <SeverityBadge severity={deployment.latest_drift_severity} />
          <span className="ml-auto">Health checked {fmtRelative(deployment.last_health_at)}</span>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
        <div className="overflow-x-auto">
          <TabsList>
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <TabsTrigger key={item.key} value={item.key}>
                  <Icon className="size-3.5" /> {item.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="overview">
          <DeploymentOverviewPanel deployment={deployment} />
        </TabsContent>
        <TabsContent value="playground">
          <DeploymentPlaygroundPanel deployment={deployment} />
        </TabsContent>
        <TabsContent value="predictions">
          <DeploymentPredictionsPanel deployment={deployment} />
        </TabsContent>
        <TabsContent value="retraining">
          <DeploymentRetrainingPanel deployment={deployment} />
        </TabsContent>
        <TabsContent value="drift">
          <DeploymentDriftPanel deployment={deployment} />
        </TabsContent>
        <TabsContent value="settings">
          <DeploymentSettingsPanel deployment={deployment} />
        </TabsContent>
      </Tabs>

      <SectionCard title="Deployment guarantees" contentClassName="pt-2">
        <div className="grid gap-3 text-[11px] leading-relaxed text-muted-foreground sm:grid-cols-3">
          <p className="flex items-start gap-2">
            <Gauge className="mt-0.5 size-3.5 shrink-0 text-primary" />
            Artifacts are loaded from the registry by key and verified against the recorded SHA-256 before scoring.
          </p>
          <p className="flex items-start gap-2">
            <Radar className="mt-0.5 size-3.5 shrink-0 text-primary" />
            Drift and performance reports are historical evidence. They never trigger automatic deployment or rollback.
          </p>
          <p className="flex items-start gap-2">
            <BrainCircuit className="mt-0.5 size-3.5 shrink-0 text-primary" />
            Local and global explanations use the deployed model&apos;s preprocessing and original feature names.
          </p>
        </div>
      </SectionCard>
    </div>
  );
}
