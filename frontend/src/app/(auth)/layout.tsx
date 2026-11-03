import type { Metadata } from "next";
import { Aperture, CheckCircle2, GitBranch, ShieldCheck, Sparkles } from "lucide-react";

export const metadata: Metadata = {
  title: "Sign in",
};

const STEPS = ["Train", "Validate", "Approve", "Deploy", "Monitor"];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[oklch(0.19_0.03_277)] text-white lg:flex lg:flex-col">
        <div className="grid-backdrop absolute inset-0 opacity-[0.12]" />
        <div className="absolute -left-24 top-1/3 size-[28rem] rounded-full bg-primary/30 blur-[120px]" />
        <div className="absolute -bottom-40 right-0 size-[24rem] rounded-full bg-chart-2/25 blur-[110px]" />
        <div className="relative flex h-full flex-col p-10 xl:p-14">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20 backdrop-blur">
              <Aperture className="size-5" />
            </span>
            <div>
              <p className="text-sm font-semibold tracking-tight">Aperture</p>
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/50">MLOps control plane</p>
            </div>
          </div>

          <div className="mt-auto max-w-xl">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] text-white/70">
              <Sparkles className="size-3" /> From dataset to monitored deployment
            </div>
            <h1 className="text-balance text-4xl font-semibold leading-[1.12] tracking-tight xl:text-5xl">
              Ship models you can explain, audit, and trust.
            </h1>
            <p className="mt-5 max-w-lg text-sm leading-relaxed text-white/65">
              Real training, a governed registry, drift detection, ground-truth performance monitoring, and an
              auditable alert workflow — in one workspace.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-1.5">
              {STEPS.map((step, index) => (
                <div key={step} className="flex items-center gap-1.5">
                  <span className="rounded-md border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] text-white/75">{step}</span>
                  {index < STEPS.length - 1 ? <span className="text-white/25">→</span> : null}
                </div>
              ))}
            </div>

            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm">
                <ShieldCheck className="mb-2 size-4 text-emerald-300" />
                <p className="text-xs font-medium">Human approval by default</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/55">
                  A passing validation score never promotes a model. Every promotion and deployment is explicit and audited.
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.04] p-4 backdrop-blur-sm">
                <GitBranch className="mb-2 size-4 text-sky-300" />
                <p className="text-xs font-medium">Evidence, not guesswork</p>
                <p className="mt-1 text-[11px] leading-relaxed text-white/55">
                  Drift, prediction shift, labels, and concept-drift checks stay clearly separated — with limitations stated.
                </p>
              </div>
            </div>
          </div>

          <div className="mt-auto pt-10 text-[10px] text-white/35">
            Aperture is a reference implementation. Configure secrets and production infrastructure before real use.
          </div>
        </div>
      </section>

      <section className="flex min-h-screen flex-col bg-background">
        <div className="flex items-center gap-2 border-b px-6 py-4 lg:hidden">
          <span className="flex size-8 items-center justify-center rounded-lg bg-[linear-gradient(135deg,var(--primary),var(--chart-2))] text-white">
            <Aperture className="size-4" />
          </span>
          <span className="text-sm font-semibold">Aperture</span>
        </div>
        <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
          <div className="w-full max-w-sm animate-fade-in">{children}</div>
        </div>
        <div className="flex items-center justify-center gap-1.5 px-6 py-5 text-[10px] text-muted-foreground">
          <CheckCircle2 className="size-3 text-success" /> Secrets stay in environment variables. Demo traffic is always labelled.
        </div>
      </section>
    </div>
  );
}
