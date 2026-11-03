"use client";

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Bell,
  Building2,
  CheckCircle2,
  KeyRound,
  Mail,
  MessageSquare,
  Plus,
  RefreshCw,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { SectionCard, StatusBadge } from "@/components/common";
import { useAuth } from "@/components/providers";
import {
  Badge,
  Button,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Input,
  InlineNote,
  LoadingBlock,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  StatCard,
  Table,
  TableShell,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import {
  useAdminOverview,
  useAdminUsers,
  useAuditEvents,
  useDebouncedValue,
  useMembers,
  useSettings,
  useWorkspaces,
} from "@/lib/hooks";
import type { Member, SettingsSnapshot, Workspace } from "@/lib/types";
import { errorMessage, fmtBytes, fmtDate, fmtRelative, safeJson, titleCase } from "@/lib/utils";

function useInvalidateSettings() {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
    void queryClient.invalidateQueries({ queryKey: ["members"] });
    void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    void queryClient.invalidateQueries({ queryKey: ["audit-events"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-overview"] });
    void queryClient.invalidateQueries({ queryKey: ["admin-users"] });
  }, [queryClient]);
}

// ------------------------------------------------------------------ account

function AccountPanel({ settings }: { settings: SettingsSnapshot }) {
  const invalidate = useInvalidateSettings();
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);

  const changePassword = useMutation({
    mutationFn: () =>
      api("/auth/change-password", {
        method: "POST",
        body: { current_password: currentPassword, new_password: newPassword },
      }),
    onSuccess: () => {
      toast.success("Password changed. Other sessions have been signed out.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setFormError(null);
      invalidate();
    },
    onError: (error) => {
      setFormError(errorMessage(error));
      toast.error(errorMessage(error));
    },
  });

  const valid =
    currentPassword.length > 0 &&
    newPassword.length >= 10 &&
    /[A-Za-z]/.test(newPassword) &&
    /\d/.test(newPassword) &&
    newPassword === confirmPassword;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Profile" description="Identity is managed by the platform. Workspace roles are scoped separately.">
        <dl className="space-y-2 text-xs">
          <div className="flex items-center justify-between gap-3 border-b pb-2">
            <dt className="text-muted-foreground">Full name</dt>
            <dd className="font-medium">{settings.user.full_name}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b pb-2">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="font-medium">{settings.user.email}</dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b pb-2">
            <dt className="text-muted-foreground">System role</dt>
            <dd>
              <Badge tone={settings.user.system_role === "admin" ? "danger" : "muted"}>
                {titleCase(settings.user.system_role)}
              </Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 border-b pb-2">
            <dt className="text-muted-foreground">Workspace role</dt>
            <dd>
              <Badge tone={settings.user.is_workspace_admin ? "primary" : "muted"}>
                {titleCase(settings.user.workspace_role)}
              </Badge>
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-muted-foreground">Workspace</dt>
            <dd className="font-medium">{settings.workspace.name}</dd>
          </div>
        </dl>
        <InlineNote tone="info" className="mt-4">
          Access tokens are short-lived ({settings.security.access_token_minutes} minutes) and refresh tokens expire
          after {settings.security.refresh_token_days} days. Refresh tokens are stored in an HttpOnly cookie.
        </InlineNote>
      </SectionCard>

      <SectionCard title="Change password" description="Changing your password revokes every active refresh token for this account.">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) changePassword.mutate();
          }}
        >
          <Field label="Current password" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
            />
          </Field>
          <Field label="New password" required hint="At least 10 characters, with a letter and a number">
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
            />
          </Field>
          <Field label="Confirm new password" required>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </Field>
          {confirmPassword && newPassword !== confirmPassword ? (
            <p className="text-[11px] text-destructive">Passwords do not match.</p>
          ) : null}
          {formError ? <InlineNote tone="danger">{formError}</InlineNote> : null}
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={!valid || changePassword.isPending}>
              <KeyRound /> {changePassword.isPending ? "Changing…" : "Change password"}
            </Button>
            <span className="text-[11px] text-muted-foreground">Other sessions will need to sign in again.</span>
          </div>
        </form>
      </SectionCard>
    </div>
  );
}

// ------------------------------------------------------------------ workspace

function WorkspacePanel({ settings }: { settings: SettingsSnapshot }) {
  const { reload } = useAuth();
  const invalidate = useInvalidateSettings();
  const { data: workspaces } = useWorkspaces();
  const { data: members } = useMembers();
  const [name, setName] = React.useState(settings.workspace.name);

  React.useEffect(() => {
    setName(settings.workspace.name);
  }, [settings.workspace.name]);

  const update = useMutation({
    mutationFn: () => api<Workspace>("/workspaces/current", { method: "PATCH", body: { name: name.trim() } }),
    onSuccess: async () => {
      toast.success("Workspace updated.");
      await reload();
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  const isAdmin = settings.user.is_workspace_admin;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <SectionCard title="Workspace details" description="Every project, dataset, deployment, alert, and audit event is scoped to a workspace.">
        <div className="space-y-3">
          <Field label="Workspace name" required>
            <Input value={name} onChange={(event) => setName(event.target.value)} disabled={!isAdmin} />
          </Field>
          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">Slug</dt>
              <dd className="font-mono text-[11px]">{settings.workspace.slug}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Your role</dt>
              <dd>
                <Badge tone={isAdmin ? "primary" : "muted"}>{titleCase(settings.workspace.role)}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Projects</dt>
              <dd className="font-medium tabular-nums">{settings.workspace.project_count}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Members</dt>
              <dd className="font-medium tabular-nums">{members?.length ?? "—"}</dd>
            </div>
          </dl>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => update.mutate()}
              disabled={!isAdmin || update.isPending || name.trim().length < 2 || name.trim() === settings.workspace.name}
            >
              {update.isPending ? "Saving…" : "Save workspace"}
            </Button>
            {!isAdmin ? <span className="text-[11px] text-muted-foreground">Workspace administrators can rename the workspace.</span> : null}
          </div>
        </div>
        <div className="mt-4 rounded-lg border bg-muted/20 p-3 text-xs">
          <div className="font-medium">Workspace settings</div>
          {Object.keys(settings.workspace.settings ?? {}).length ? (
            <CodeBlock className="mt-2">{safeJson(settings.workspace.settings)}</CodeBlock>
          ) : (
            <p className="mt-1 text-muted-foreground">
              No custom workspace settings are stored. Operational limits and retention are controlled by server
              environment variables, not per-workspace overrides.
            </p>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Your workspaces" description="Switch workspaces from the sidebar. Data is never shared across workspace boundaries.">
        {workspaces?.length ? (
          <ul className="space-y-2">
            {workspaces.map((workspace) => (
              <li
                key={workspace.id}
                className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2.5 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{workspace.name}</div>
                  <div className="font-mono text-[10px] text-muted-foreground">{workspace.slug}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {workspace.id === settings.workspace.id ? <Badge tone="success">Current</Badge> : null}
                  <Badge tone="muted">{titleCase(workspace.role)}</Badge>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No workspace memberships were returned.</p>
        )}
        <InlineNote tone="info" className="mt-4">
          The frontend sends the selected workspace in the <span className="font-mono">X-Workspace-Id</span> header. The
          API re-validates membership on every request; a forged workspace ID cannot bypass authorization.
        </InlineNote>
      </SectionCard>
    </div>
  );
}

// ------------------------------------------------------------------ members

function AddMemberDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateSettings();
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState("member");

  React.useEffect(() => {
    if (!open) {
      setEmail("");
      setRole("member");
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      api<Member>("/workspaces/current/members", {
        method: "POST",
        body: { email: email.trim(), role },
      }),
    onSuccess: () => {
      toast.success("Member added to the workspace.");
      invalidate();
      onOpenChange(false);
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add workspace member</DialogTitle>
          <DialogDescription>
            The account must already exist. Adding a member grants access to every project and deployment in this
            workspace according to the selected role.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <Field label="Account email" required>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
            />
          </Field>
          <Field label="Workspace role">
            <Select value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </Select>
          </Field>
          <InlineNote tone="info">
            Owners and admins can approve models, deploy, manage alert rules, and view audit events. Members can train,
            predict, and manage incidents.
          </InlineNote>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !email.trim()}>
            {mutation.isPending ? "Adding…" : "Add member"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersPanel({ settings }: { settings: SettingsSnapshot }) {
  const invalidate = useInvalidateSettings();
  const { data, isLoading, isError, error, refetch } = useMembers();
  const [addOpen, setAddOpen] = React.useState(false);
  const isAdmin = settings.user.is_workspace_admin;

  const updateRole = useMutation({
    mutationFn: ({ member, role }: { member: Member; role: string }) =>
      api<Member>(`/workspaces/current/members/${member.user_id}`, {
        method: "PATCH",
        body: { role },
      }),
    onSuccess: () => {
      toast.success("Member role updated.");
      invalidate();
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  const removeMember = useMutation({
    mutationFn: (member: Member) => api(`/workspaces/current/members/${member.user_id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Member removed from the workspace.");
      invalidate();
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Workspace roles: <span className="font-medium">owner</span> and <span className="font-medium">admin</span> can
          approve models, deploy, manage alert rules, and view the audit log. <span className="font-medium">member</span>{" "}
          can train, deploy-approved models, predict, and manage incidents.
        </p>
        <div className="flex items-center gap-2">
          <Badge tone="muted">{data?.length ?? 0} members</Badge>
          <Button size="sm" onClick={() => setAddOpen(true)} disabled={!isAdmin}>
            <Plus /> Add member
          </Button>
        </div>
      </div>

      {isLoading ? <LoadingBlock label="Loading members…" /> : null}
      {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && data?.length ? (
        <TableShell>
          <Table>
            <THead>
              <TR>
                <TH>Member</TH>
                <TH>Workspace role</TH>
                <TH>System role</TH>
                <TH>Joined</TH>
                <TH className="text-right">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {data.map((member) => (
                <TR key={member.user_id}>
                  <TD>
                    <div className="text-xs font-medium">{member.full_name}</div>
                    <div className="text-[11px] text-muted-foreground">{member.email}</div>
                  </TD>
                  <TD>
                    {isAdmin ? (
                      <Select
                        value={member.role}
                        onChange={(event) => updateRole.mutate({ member, role: event.target.value })}
                        disabled={updateRole.isPending}
                        className="h-8 w-36 text-xs"
                        aria-label={`Role for ${member.full_name}`}
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </Select>
                    ) : (
                      <Badge tone={member.role === "member" ? "muted" : "primary"}>{titleCase(member.role)}</Badge>
                    )}
                  </TD>
                  <TD>
                    <Badge tone={member.system_role === "admin" ? "danger" : "muted"}>{titleCase(member.system_role)}</Badge>
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(member.created_at)}</TD>
                  <TD>
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${member.full_name}`}
                        disabled={!isAdmin || member.user_id === settings.user.id || removeMember.isPending}
                        title={
                          member.user_id === settings.user.id
                            ? "You cannot remove yourself"
                            : "Remove from workspace"
                        }
                        onClick={() => removeMember.mutate(member)}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </div>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      ) : null}

      {!isAdmin ? (
        <InlineNote tone="info">
          Only workspace administrators can add, remove, or change member roles. The last owner cannot be demoted or
          removed, and you cannot remove your own owner role.
        </InlineNote>
      ) : null}

      <AddMemberDialog open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}

// ------------------------------------------------------------------ notifications

function NotificationTestDialog({
  channel,
  onClose,
  configured,
}: {
  channel: "email" | "slack" | null;
  onClose: () => void;
  configured: boolean;
}) {
  const invalidate = useInvalidateSettings();
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>("/settings/notifications/test", {
        method: "POST",
        body: { channel },
      }),
    onSuccess: (payload) => {
      setResult(payload);
      const status = (payload.result as Record<string, unknown> | undefined)?.status;
      if (status === "skipped") toast.warning("Channel is not configured; no notification was sent.");
      else toast.success("Test notification dispatched.");
      invalidate();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Dialog open={Boolean(channel)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Test {channel === "email" ? "email" : "Slack"} notifications</DialogTitle>
          <DialogDescription>
            {configured
              ? "Sends a test message using the server configuration. The attempt is recorded in the audit log."
              : "This channel is not configured on the server. The API will record a skipped result and send nothing."}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {!configured ? (
            <InlineNote tone="warning">
              Set the SMTP variables or <span className="font-mono">SLACK_WEBHOOK_URL</span> in the backend environment to
              enable this channel.
            </InlineNote>
          ) : null}
          {result ? <CodeBlock>{safeJson(result)}</CodeBlock> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            <Send /> {mutation.isPending ? "Sending…" : "Send test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NotificationsPanel({ settings }: { settings: SettingsSnapshot }) {
  const [testChannel, setTestChannel] = React.useState<"email" | "slack" | null>(null);
  const notifications = settings.notifications;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 lg:grid-cols-3">
        <SectionCard title="In-app" description="Alerts are always visible in the Alerts & Incidents page.">
          <div className="flex items-center gap-2">
            <Badge tone="success">
              <CheckCircle2 /> Always enabled
            </Badge>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Delivery is stored on the alert record. Acknowledgement, resolution, and remediation are audited.
          </p>
        </SectionCard>

        <SectionCard title="Email" description="SMTP delivery for rule-selected alerts.">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={notifications.email_configured ? "success" : "muted"}>
              {notifications.email_configured ? "Configured" : "Not configured"}
            </Badge>
            {notifications.smtp_host_configured ? <Badge tone="info">SMTP host set</Badge> : null}
            {notifications.recipients_configured ? <Badge tone="info">Recipients set</Badge> : null}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTestChannel("email")}
              disabled={!settings.user.is_workspace_admin}
              title={!settings.user.is_workspace_admin ? "Workspace administrator required" : undefined}
            >
              <Mail /> Test email
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Configure <span className="font-mono">SMTP_HOST</span>, <span className="font-mono">SMTP_FROM_EMAIL</span>, and{" "}
            <span className="font-mono">ALERT_EMAIL_TO</span> on the server. Secrets are never returned by the API.
          </p>
        </SectionCard>

        <SectionCard title="Slack" description="Incoming webhook delivery for rule-selected alerts.">
          <div className="flex items-center gap-2">
            <Badge tone={notifications.slack_configured ? "success" : "muted"}>
              {notifications.slack_configured ? "Configured" : "Not configured"}
            </Badge>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTestChannel("slack")}
              disabled={!settings.user.is_workspace_admin}
              title={!settings.user.is_workspace_admin ? "Workspace administrator required" : undefined}
            >
              <MessageSquare /> Test Slack
            </Button>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Configure <span className="font-mono">SLACK_WEBHOOK_URL</span> on the server. The webhook URL is never exposed
            to the browser.
          </p>
        </SectionCard>
      </div>

      <SectionCard title="Delivery policy" description="Notifications are best-effort; alerts remain available in-app regardless of channel status.">
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-muted-foreground">
          <li>Each alert rule selects its own channels. In-app is always included by default.</li>
          <li>Alerts are deduplicated per rule and metric for the configured cooldown window.</li>
          <li>Delivery failures are recorded on the alert and do not block alert creation or acknowledgement.</li>
          <li>Test delivery is an explicit, audited action. No notification is sent automatically from this page.</li>
        </ul>
      </SectionCard>

      <NotificationTestDialog
        channel={testChannel}
        configured={testChannel === "email" ? notifications.email_configured : notifications.slack_configured}
        onClose={() => setTestChannel(null)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ audit

function AuditPanel() {
  const [action, setAction] = React.useState("");
  const [entityType, setEntityType] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [offset, setOffset] = React.useState(0);
  const debouncedSearch = useDebouncedValue(search);
  const limit = 25;

  React.useEffect(() => {
    setOffset(0);
  }, [action, entityType, debouncedSearch]);

  const { data, isLoading, isError, error, refetch } = useAuditEvents({
    action: action || undefined,
    entity_type: entityType || undefined,
    q: debouncedSearch || undefined,
    limit,
    offset,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={action} onChange={(event) => setAction(event.target.value)} className="h-8 w-56 text-xs" aria-label="Audit action filter">
          <option value="">All actions</option>
          {(data?.available_actions ?? []).map((item) => (
            <option key={item.action} value={item.action}>
              {item.action} ({item.count})
            </option>
          ))}
        </Select>
        <Input
          value={entityType}
          onChange={(event) => setEntityType(event.target.value)}
          placeholder="Entity type (e.g. deployment)"
          className="h-8 w-56 text-xs"
          aria-label="Entity type filter"
        />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search action or entity…"
          className="h-8 w-56 text-xs"
          aria-label="Search audit events"
        />
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
          <RefreshCw className={isLoading ? "animate-spin" : undefined} /> Refresh
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {data ? `${data.total} event${data.total === 1 ? "" : "s"}` : "—"}
        </span>
      </div>

      {isLoading ? <LoadingBlock label="Loading audit events…" /> : null}
      {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {!isLoading && !isError && !data?.items.length ? (
        <EmptyState
          icon={ScrollText}
          title="No audit events match this view"
          description="Approvals, deployments, alert actions, member changes, and settings updates are recorded automatically."
        />
      ) : null}

      {data?.items.length ? (
        <>
          <TableShell>
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Entity</TH>
                  <TH>IP address</TH>
                  <TH>Details</TH>
                </TR>
              </THead>
              <TBody>
                {data.items.map((event) => (
                  <TR key={event.id} className="align-top">
                    <TD className="whitespace-nowrap text-xs">
                      <div>{fmtDate(event.created_at)}</div>
                      <div className="text-[11px] text-muted-foreground">{fmtRelative(event.created_at)}</div>
                    </TD>
                    <TD className="text-xs">{event.actor_name ?? "System"}</TD>
                    <TD>
                      <Badge tone="info">{event.action}</Badge>
                    </TD>
                    <TD className="text-xs">
                      <div>{titleCase(event.entity_type)}</div>
                      <div className="font-mono text-[10px] text-muted-foreground">{event.entity_id ?? "—"}</div>
                    </TD>
                    <TD className="font-mono text-[11px]">{event.ip_address ?? "—"}</TD>
                    <TD className="max-w-96">
                      <details className="text-xs">
                        <summary className="cursor-pointer text-muted-foreground">View details</summary>
                        <CodeBlock className="mt-1 max-h-48">{safeJson(event.details)}</CodeBlock>
                        {event.user_agent ? (
                          <p className="mt-1 break-all text-[10px] text-muted-foreground">{event.user_agent}</p>
                        ) : null}
                      </details>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableShell>
          <Pagination total={data.total} limit={limit} offset={offset} onChange={setOffset} />
        </>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ system

function SystemUsersPanel({ systemAdmin }: { systemAdmin: boolean }) {
  const invalidate = useInvalidateSettings();
  const { data, isLoading, isError, error, refetch } = useAdminUsers(systemAdmin);

  const updateRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      api(`/admin/users/${userId}/role`, { method: "PATCH", body: { role } }),
    onSuccess: () => {
      toast.success("System role updated.");
      invalidate();
    },
    onError: (mutationError) => toast.error(errorMessage(mutationError)),
  });

  if (!systemAdmin) {
    return (
      <InlineNote tone="info">
        System user roles can only be changed by a system administrator. Workspace roles are managed on the Members tab.
      </InlineNote>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          System administrators can manage every workspace. Workspace administrators only manage their own workspace.
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isLoading}>
          <RefreshCw className={isLoading ? "animate-spin" : undefined} /> Refresh
        </Button>
      </div>
      {isLoading ? <LoadingBlock label="Loading system users…" /> : null}
      {isError ? <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} /> : null}
      {data?.length ? (
        <TableShell>
          <Table>
            <THead>
              <TR>
                <TH>User</TH>
                <TH>System role</TH>
                <TH>Status</TH>
                <TH>Last login</TH>
                <TH>Created</TH>
              </TR>
            </THead>
            <TBody>
              {data.map((user) => (
                <TR key={user.id}>
                  <TD>
                    <div className="text-xs font-medium">{user.full_name}</div>
                    <div className="text-[11px] text-muted-foreground">{user.email}</div>
                  </TD>
                  <TD>
                    <Select
                      value={user.role}
                      onChange={(event) => updateRole.mutate({ userId: user.id, role: event.target.value })}
                      disabled={updateRole.isPending}
                      className="h-8 w-32 text-xs"
                      aria-label={`System role for ${user.full_name}`}
                    >
                      <option value="user">User</option>
                      <option value="admin">Admin</option>
                    </Select>
                  </TD>
                  <TD>
                    <StatusBadge status={user.is_active ? "active" : "paused"} label={user.is_active ? "Active" : "Inactive"} />
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">
                    {user.last_login_at ? fmtRelative(user.last_login_at) : "Never"}
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(user.created_at)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </TableShell>
      ) : null}
    </div>
  );
}

function SystemPanel({ settings }: { settings: SettingsSnapshot }) {
  const overview = useAdminOverview();
  const counts = overview.data?.counts ?? {};
  const health = overview.data?.storage_health as
    | { backend?: string; ok?: boolean; detail?: string; [key: string]: unknown }
    | undefined;
  const mlflow = overview.data?.mlflow_health as
    | { ok?: boolean; enabled?: boolean; registry_enabled?: boolean; mode?: string; detail?: string; [key: string]: unknown }
    | undefined;
  const db = overview.data?.database;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Projects"
          value={counts.projects ?? 0}
          hint={`${counts.datasets ?? 0} datasets · ${counts.training_runs ?? 0} runs`}
          icon={Building2}
          loading={overview.isLoading}
        />
        <StatCard
          title="Registered models"
          value={counts.registered_models ?? 0}
          hint={`${counts.model_versions ?? 0} versions · ${counts.pending_approvals ?? 0} pending approval`}
          icon={ShieldCheck}
          tone="info"
          loading={overview.isLoading}
        />
        <StatCard
          title="Deployments"
          value={counts.deployments ?? 0}
          hint={`${counts.predictions ?? 0} prediction events`}
          icon={Activity}
          tone="primary"
          loading={overview.isLoading}
        />
        <StatCard
          title="Open attention"
          value={(counts.open_alerts ?? 0) + (counts.open_incidents ?? 0)}
          hint={`${counts.open_alerts ?? 0} alerts · ${counts.open_incidents ?? 0} incidents`}
          icon={Bell}
          tone={(counts.open_alerts ?? 0) + (counts.open_incidents ?? 0) ? "warning" : "success"}
          loading={overview.isLoading}
        />
      </div>

      {overview.isError ? <ErrorState message={errorMessage(overview.error)} onRetry={() => void overview.refetch()} /> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Runtime" description="Derived from server environment. Secrets are never returned.">
          {overview.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-64" />
              <Skeleton className="h-4 w-40" />
            </div>
          ) : (
            <dl className="space-y-2 text-xs">
              <div className="flex justify-between gap-3 border-b pb-2">
                <dt className="text-muted-foreground">Environment</dt>
                <dd>
                  <Badge tone={settings.platform.environment === "production" ? "warning" : "info"}>
                    {titleCase(settings.platform.environment)}
                  </Badge>
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b pb-2">
                <dt className="text-muted-foreground">Job runner</dt>
                <dd className="font-medium">{titleCase(settings.platform.job_runner)}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b pb-2">
                <dt className="text-muted-foreground">Storage backend</dt>
                <dd className="font-medium">{titleCase(settings.platform.storage_backend)}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b pb-2">
                <dt className="text-muted-foreground">Scheduler</dt>
                <dd className="font-medium">{settings.platform.scheduler_enabled ? "Enabled" : "Disabled"}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b pb-2">
                <dt className="text-muted-foreground">OpenTelemetry</dt>
                <dd className="font-medium">{settings.platform.otel_enabled ? "Enabled" : "Disabled"}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Demo mode</dt>
                <dd className="font-medium">{settings.platform.demo_mode ? "Enabled" : "Disabled"}</dd>
              </div>
            </dl>
          )}
        </SectionCard>

        <SectionCard title="Database & storage" description="Live health checks from the API process.">
          <dl className="space-y-2 text-xs">
            <div className="flex justify-between gap-3 border-b pb-2">
              <dt className="text-muted-foreground">Database dialect</dt>
              <dd className="font-medium">{db?.dialect ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b pb-2">
              <dt className="text-muted-foreground">Database size</dt>
              <dd className="font-medium tabular-nums">{db?.size_bytes != null ? fmtBytes(db.size_bytes) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b pb-2">
              <dt className="text-muted-foreground">Storage health</dt>
              <dd>
                <StatusBadge status={health?.ok ? "healthy" : "unhealthy"} label={health?.ok ? "Healthy" : "Unhealthy"} />
              </dd>
            </div>
            <div className="flex justify-between gap-3 border-b pb-2">
              <dt className="text-muted-foreground">Storage backend</dt>
              <dd className="font-medium">{titleCase(String(health?.backend ?? settings.platform.storage_backend))}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">MLflow</dt>
              <dd>
                <StatusBadge
                  status={mlflow?.ok ? "healthy" : "unhealthy"}
                  label={mlflow?.ok ? "Reachable" : "Unavailable"}
                />
              </dd>
            </div>
          </dl>
          {health?.detail ? <p className="mt-3 text-[11px] text-muted-foreground">{String(health.detail)}</p> : null}
          {mlflow ? (
            <details className="mt-3 rounded-lg border p-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">MLflow health details</summary>
              <CodeBlock className="mt-2 max-h-40">{safeJson(mlflow)}</CodeBlock>
            </details>
          ) : null}
        </SectionCard>

        <SectionCard title="Limits & security" description="Operational limits are enforced by the API, not just displayed.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Max upload</dt>
              <dd className="font-medium tabular-nums">{settings.limits.max_upload_mb} MB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max rows</dt>
              <dd className="font-medium tabular-nums">{settings.limits.max_dataset_rows.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max columns</dt>
              <dd className="font-medium tabular-nums">{settings.limits.max_dataset_columns}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Max batch</dt>
              <dd className="font-medium tabular-nums">{settings.limits.max_batch_size}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Prediction body</dt>
              <dd className="font-medium tabular-nums">{settings.limits.max_prediction_body_kb} KB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Predict rate limit</dt>
              <dd className="font-medium tabular-nums">{settings.limits.rate_limit_predict_per_minute}/min</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">API rate limit</dt>
              <dd className="font-medium tabular-nums">{settings.limits.rate_limit_api_per_minute}/min</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Secure cookies</dt>
              <dd className="font-medium">{settings.security.cookie_secure ? "Yes" : "No (local dev)"}</dd>
            </div>
          </dl>
          <div className="mt-3">
            <div className="text-[11px] text-muted-foreground">CORS origins</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {settings.security.cors_origins.length ? (
                settings.security.cors_origins.map((origin) => (
                  <Badge key={origin} tone="muted" className="font-mono text-[10px]">
                    {origin}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted-foreground">None configured</span>
              )}
            </div>
          </div>
        </SectionCard>

        <SectionCard title="Monitoring configuration" description="Drift and performance thresholds are applied by the analysis services.">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Drift engine</dt>
              <dd className="font-medium">{titleCase(settings.monitoring.drift_engine)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">FDR alpha</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.drift_alpha}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">PSI threshold</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.drift_psi_threshold}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Drifted share</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.drift_share_threshold}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Min drift samples</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.min_drift_samples}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Min label samples</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.default_min_label_samples}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Perf. drop threshold</dt>
              <dd className="font-medium tabular-nums">{settings.monitoring.performance_degradation_threshold}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Raw input logging</dt>
              <dd className="font-medium">{settings.monitoring.raw_input_logging ? "Enabled" : "Disabled (default)"}</dd>
            </div>
          </dl>
          <InlineNote tone="info" className="mt-3">
            Raw prediction inputs are not logged by default. Monitoring uses bounded, sampled feature snapshots so drift
            and explanations can be computed without retaining unrestricted request payloads.
          </InlineNote>
        </SectionCard>
      </div>

      <SectionCard title="Feature status" description="Features are enabled by server configuration, not by client toggles.">
        <div className="flex flex-wrap gap-2">
          {settings.features.map((feature) => (
            <Badge key={feature.key} tone={feature.enabled ? "success" : "muted"}>
              {titleCase(feature.key)}: {feature.enabled ? "on" : "off"}
            </Badge>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="System users" description="Cross-workspace user administration. Workspace membership is managed separately.">
        <SystemUsersPanel systemAdmin={settings.user.system_role === "admin"} />
      </SectionCard>
    </div>
  );
}

// ------------------------------------------------------------------ page

export default function SettingsPage() {
  const settings = useSettings();
  const { isAdmin } = useAuth();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="System"
        title="Settings"
        description="Account security, workspace membership, notification channels, the audit trail, and server-enforced platform configuration."
        actions={
          settings.data ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={settings.data.platform.environment === "production" ? "warning" : "info"}>
                {titleCase(settings.data.platform.environment)}
              </Badge>
              <Badge tone="muted">{settings.data.platform.job_runner} runner</Badge>
            </div>
          ) : null
        }
      />

      {settings.isLoading ? <LoadingBlock label="Loading settings…" /> : null}
      {settings.isError ? <ErrorState message={errorMessage(settings.error)} onRetry={() => void settings.refetch()} /> : null}
      {settings.data ? (
        <Tabs defaultValue="account">
          <TabsList className="flex h-auto flex-wrap">
            <TabsTrigger value="account">
              <UserRound className="size-3.5" /> Account
            </TabsTrigger>
            <TabsTrigger value="workspace">
              <Building2 className="size-3.5" /> Workspace
            </TabsTrigger>
            <TabsTrigger value="members">
              <Users className="size-3.5" /> Members
            </TabsTrigger>
            <TabsTrigger value="notifications">
              <Bell className="size-3.5" /> Notifications
            </TabsTrigger>
            {isAdmin ? (
              <TabsTrigger value="audit">
                <ScrollText className="size-3.5" /> Audit log
              </TabsTrigger>
            ) : null}
            {isAdmin ? (
              <TabsTrigger value="system">
                <Server className="size-3.5" /> System
              </TabsTrigger>
            ) : null}
          </TabsList>

          <TabsContent value="account">
            <AccountPanel settings={settings.data} />
          </TabsContent>
          <TabsContent value="workspace">
            <WorkspacePanel settings={settings.data} />
          </TabsContent>
          <TabsContent value="members">
            <MembersPanel settings={settings.data} />
          </TabsContent>
          <TabsContent value="notifications">
            <NotificationsPanel settings={settings.data} />
          </TabsContent>
          {isAdmin ? (
            <TabsContent value="audit">
              <AuditPanel />
            </TabsContent>
          ) : null}
          {isAdmin ? (
            <TabsContent value="system">
              <SystemPanel settings={settings.data} />
            </TabsContent>
          ) : null}
        </Tabs>
      ) : null}
    </div>
  );
}
