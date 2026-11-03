"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Eye, EyeOff, Loader2, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/providers";
import { Button, Field, Input, InlineNote } from "@/components/ui";
import { errorMessage } from "@/lib/utils";

export default function RegisterPage() {
  const router = useRouter();
  const { user, loading, register } = useAuth();
  const [form, setForm] = React.useState({
    full_name: "",
    email: "",
    password: "",
    workspace_name: "",
  });
  const [showPassword, setShowPassword] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  function update(key: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (form.password.length < 10) {
      setError("Use at least 10 characters for the password.");
      return;
    }
    setSubmitting(true);
    try {
      await register({
        email: form.email.trim(),
        password: form.password,
        full_name: form.full_name.trim(),
        workspace_name: form.workspace_name.trim() || `${form.full_name.trim().split(" ")[0] || "My"}'s Workspace`,
      });
      toast.success("Account created");
      router.replace("/");
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-7">
        <div className="mb-3 flex size-9 items-center justify-center rounded-lg border bg-card text-primary shadow-xs">
          <UserPlus className="size-4" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Create your workspace</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Start with a project, a dataset, and a real model.</p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
        <Field label="Full name" htmlFor="full_name" required>
          <Input
            id="full_name"
            autoComplete="name"
            placeholder="Ada Lovelace"
            value={form.full_name}
            onChange={(event) => update("full_name", event.target.value)}
            minLength={2}
            maxLength={160}
            required
            autoFocus
          />
        </Field>
        <Field label="Work email" htmlFor="email" required>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={form.email}
            onChange={(event) => update("email", event.target.value)}
            required
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="10+ characters" required>
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="Create a strong password"
              value={form.password}
              onChange={(event) => update("password", event.target.value)}
              minLength={10}
              maxLength={128}
              required
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
        </Field>
        <Field label="Workspace name" htmlFor="workspace_name" hint="Optional">
          <Input
            id="workspace_name"
            placeholder="Acme ML Platform"
            value={form.workspace_name}
            onChange={(event) => update("workspace_name", event.target.value)}
            maxLength={120}
          />
        </Field>
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? <Loader2 className="animate-spin" /> : null}
          {submitting ? "Creating workspace…" : "Create account"}
          {!submitting ? <ArrowRight /> : null}
        </Button>
      </form>

      <p className="mt-5 text-center text-xs text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
      <div className="mt-7 rounded-lg border border-dashed px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        You will be the workspace owner. Model approval, promotion, and deployment actions require workspace administrator
        privileges; the first system account also receives the system administrator role.
      </div>
    </div>
  );
}
