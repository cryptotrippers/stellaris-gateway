import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  ledgerCreateProjectSchema,
  ledgerEntriesSchema,
  ledgerOpenPeriodSchema,
  ledgerPeriodRefSchema,
  ledgerProjectRefSchema,
  parseInput,
} from "./input-guards.shared";
import type { PeriodFinancials } from "./ledger-read.shared";
import type { Result, Sourced } from "./provenance.shared";

/**
 * Sprint 2 E04 — Meridian ledger server functions.
 *
 * Every call: signed-in user → roles looked up server-side → rate limit →
 * the rules in ledger-service.server.ts → the ledger store over the service
 * role (the ledger tables have no client write grants). Results are
 * `Result<T>`; figures are `Sourced<T>` with money as decimal strings.
 */

type Ctx = {
  supabase: {
    rpc: (
      fn: string,
      args: unknown,
    ) => Promise<{ data: unknown; error: { message: string } | null }>;
  };
  userId: string;
};

export const getLedgerPeriodFinancials = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string; periodId: string }) =>
    parseInput(ledgerPeriodRefSchema, d),
  )
  .handler(async ({ data, context }): Promise<Result<Sourced<PeriodFinancials>>> => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerRead");
    const { readPeriodFinancials } = await import("./ledger-service.server");
    return readPeriodFinancials(repo, actor, data.projectId, data.periodId);
  });

export const listLedgerPeriods = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string }) => parseInput(ledgerProjectRefSchema, d))
  .handler(async ({ data, context }) => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerRead");
    const { readPeriodList } = await import("./ledger-service.server");
    return readPeriodList(repo, actor, data.projectId);
  });

export const createLedgerProjectFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string; currency: string }) =>
    parseInput(ledgerCreateProjectSchema, d),
  )
  .handler(async ({ data, context }): Promise<Result<true>> => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerWrite");
    const { createLedgerProject } = await import("./ledger-service.server");
    return createLedgerProject(repo, actor, data.projectId, data.currency);
  });

export const openLedgerPeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (d: {
      projectId: string;
      periodId: string;
      startsOn: string;
      endsOn: string;
      adjustsPeriodId?: string | null;
    }) => parseInput(ledgerOpenPeriodSchema, d),
  )
  .handler(async ({ data, context }): Promise<Result<true>> => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerWrite");
    const { openLedgerPeriod } = await import("./ledger-service.server");
    return openLedgerPeriod(repo, actor, data.projectId, {
      id: data.periodId,
      startsOn: data.startsOn,
      endsOn: data.endsOn,
      adjustsPeriodId: data.adjustsPeriodId ?? null,
    });
  });

export const recordLedgerEntriesFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string; entries: Record<string, unknown>[] }) =>
    parseInput(ledgerEntriesSchema, d),
  )
  .handler(async ({ data, context }) => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerWrite");
    const { recordLedgerEntries } = await import("./ledger-service.server");
    return recordLedgerEntries(repo, actor, data.projectId, data.entries);
  });

export const closeLedgerPeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string; periodId: string }) =>
    parseInput(ledgerPeriodRefSchema, d),
  )
  .handler(async ({ data, context }): Promise<Result<true>> => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerWrite");
    const { closeLedgerPeriod } = await import("./ledger-service.server");
    return closeLedgerPeriod(repo, actor, data.projectId, data.periodId);
  });

export const approveLedgerPeriodFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { projectId: string; periodId: string }) =>
    parseInput(ledgerPeriodRefSchema, d),
  )
  .handler(async ({ data, context }): Promise<Result<{ periodRoot: string }>> => {
    const svc = await import("./ledger-runtime.server");
    const { actor, repo } = await svc.ledgerCall(context as unknown as Ctx, "ledgerWrite");
    const { approveLedgerPeriod } = await import("./ledger-service.server");
    return approveLedgerPeriod(repo, actor, data.projectId, data.periodId);
  });
