"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, FolderKanban, Plus, Rocket, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { SearchField, StatusBadge, TaskBadge } from "@/components/common";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  StatCard,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
} from "@/components/ui";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useDebouncedValue, useProjects } from "@/lib/hooks";
import type { Project, TaskType } from "@/lib/types";
import { errorMessage, fmtMetric, fmtRelative, primaryMetricLabel, primaryMetricName, titleCase } from "@/lib/utils";

const LIMIT = 12;

function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [taskType, setTaskType] = React.useState<TaskType>("classification");
  const [targetColumn, setTargetColumn] = React.useState("");
  const [positiveLabel, setPositiveLabel] = React.useState("");

  const mutation = useMutation({
    mutationFn: () =>
      api<Project>("/projects", {
        method: "POST",
        body: {
          name: name.trim(),
          description: description.trim(),
          task_type: taskType,
          target_column: targetColumn.trim(),
          positive_label: positiveLabel.trim() || null,
        },
      }),
    onSuccess: (project) => {
      toast.success("Project created.");
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onOpenChange(false);
      router.push(`/projects/${project.id}`);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  React.useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setTargetColumn("");
      setPositiveLabel("");
      setTaskType("classification");
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create project</DialogTitle>
          <DialogDescription>
            A project defines the prediction task and target. The target column must exist in every dataset you upload.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <DialogBody className="space-y-3">
            <Field label="Project name" required htmlFor="project-name">
              <Input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Customer churn"
                minLength={2}
                maxLength={160}
                required
              />
            </Field>
            <Field label="Description" htmlFor="project-description">
              <Textarea
                id="project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What decision does this model support?"
                maxLength={4000}
                rows={3}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Task type" required htmlFor="project-task-type">
                <Select
                  id="project-task-type"
                  value={taskType}
                  onChange={(event) => setTaskType(event.target.value as TaskType)}
                >
                  <option value="classification">Classification</option>
                  <option value="regression">Regression</option>
                </Select>
              </Field>
              <Field label="Target column" required htmlFor="project-target" hint="Must match the CSV">
                <Input
                  id="project-target"
                  value={targetColumn}
                  onChange={(event) => setTargetColumn(event.target.value)}
                  placeholder={taskType === "classification" ? "is_churned" : "price"}
                  maxLength={160}
                  required
                />
              </Field>
            </div>
            {taskType === "classification" ? (
              <Field label="Positive label" htmlFor="project-positive" hint="Optional · used for interpretation only">
                <Input
                  id="project-positive"
                  value={positiveLabel}
                  onChange={(event) => setPositiveLabel(event.target.value)}
                  placeholder="1"
                  maxLength={120}
                />
              </Field>
            ) : null}
            <div className="rounded-lg border border-dashed bg-muted/20 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
              <Sparkles className="mr-1 inline size-3" />
              Tip: use the built-in synthetic sample datasets after creating the project. For churn use target{" "}
              <code className="rounded bg-muted px-1">is_churned</code>; for house prices use{" "}
              <code className="rounded bg-muted px-1">price</code>.
            </div>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending || name.trim().length < 2 || !targetColumn.trim()}>
              {mutation.isPending ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ProjectsPage() {
  const [search, setSearch] = React.useState("");
  const debouncedSearch = useDebouncedValue(search);
  const [status, setStatus] = React.useState("");
  const [sort, setSort] = React.useState("updated_at");
  const [order, setOrder] = React.useState("desc");
  const [offset, setOffset] = React.useState(0);
  const [createOpen, setCreateOpen] = React.useState(false);
  const { data, isLoading, error, refetch } = useProjects({
    q: debouncedSearch || undefined,
    status: status || undefined,
    sort,
    order,
    limit: LIMIT,
    offset,
  });

  React.useEffect(() => {
    setOffset(0);
  }, [debouncedSearch, status, sort, order]);

  const total = data?.total ?? 0;
  const projects = data?.items ?? [];
  const activeCount = projects.filter((project) => project.status === "active").length;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Projects"
        description="Organize datasets, experiments, registered models and deployments around a prediction task."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus /> New project
          </Button>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard title="Projects" value={total} hint="In this workspace" icon={FolderKanban} tone="primary" loading={isLoading} />
        <StatCard title="Active on this page" value={activeCount} hint={`${projects.length} shown`} icon={Rocket} tone="success" loading={isLoading} />
        <StatCard
          title="Registered models"
          value={projects.reduce((sum, project) => sum + project.model_count, 0)}
          hint="Across projects on this page"
          icon={Sparkles}
          tone="info"
          loading={isLoading}
        />
      </div>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <SearchField value={search} onChange={setSearch} placeholder="Search projects…" />
          <Select value={status} onChange={(event) => setStatus(event.target.value)} className="h-8 w-auto text-xs" aria-label="Project status">
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="archived">Archived</option>
          </Select>
          <Select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 w-auto text-xs" aria-label="Sort by">
            <option value="updated_at">Recently updated</option>
            <option value="created_at">Newest</option>
            <option value="name">Name</option>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setOrder((current) => (current === "desc" ? "asc" : "desc"))}
            aria-label="Toggle sort direction"
          >
            {order === "desc" ? "Descending" : "Ascending"}
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">{total} total</span>
        </div>
      </Card>

      {error ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}

      {isLoading ? (
        <LoadingBlock label="Loading projects…" />
      ) : projects.length === 0 ? (
        <EmptyState
          title={debouncedSearch || status ? "No projects match these filters" : "No projects yet"}
          description={
            debouncedSearch || status
              ? "Clear the search and status filters to see all projects."
              : "Create a project, add a dataset, then train and register a real model."
          }
          icon={FolderKanban}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Create project
            </Button>
          }
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <THead>
                <TR>
                  <TH>Project</TH>
                  <TH>Task</TH>
                  <TH>Status</TH>
                  <TH>Assets</TH>
                  <TH>Latest run</TH>
                  <TH>Updated</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {projects.map((project) => {
                  const primary = primaryMetricName(project.task_type);
                  const value =
                    project.latest_run && typeof project.latest_run.metrics?.[primary] === "number"
                      ? Number(project.latest_run.metrics[primary])
                      : null;
                  return (
                    <TR key={project.id}>
                      <TD className="min-w-52">
                        <Link href={`/projects/${project.id}`} className="text-sm font-medium hover:text-primary hover:underline">
                          {project.name}
                        </Link>
                        <p className="mt-0.5 max-w-md truncate text-[11px] text-muted-foreground">
                          {project.description || "No description"}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">target: {project.target_column || "unset"}</p>
                      </TD>
                      <TD>
                        <TaskBadge taskType={project.task_type} />
                      </TD>
                      <TD>
                        <StatusBadge status={project.status} />
                      </TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone="muted">{project.dataset_count} data</Badge>
                          <Badge tone="muted">{project.model_count} models</Badge>
                          <Badge tone="muted">{project.deployment_count} deploys</Badge>
                        </div>
                      </TD>
                      <TD className="min-w-40">
                        {project.latest_run ? (
                          <>
                            <span className="block max-w-44 truncate text-xs">{project.latest_run.name}</span>
                            <span className="text-[10px] text-muted-foreground">
                              {primaryMetricLabel(project.task_type)} {fmtMetric(value, 4)} · {titleCase(project.latest_run.status)}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs text-muted-foreground">No runs</span>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtRelative(project.updated_at)}</TD>
                      <TD className="text-right">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/projects/${project.id}`}>
                            Open <ArrowRight />
                          </Link>
                        </Button>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </div>
          <Pagination total={total} limit={LIMIT} offset={offset} onChange={setOffset} />
        </div>
      )}

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
