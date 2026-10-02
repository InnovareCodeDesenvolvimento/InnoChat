"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { pagingInputShape } from "@/modules/billing/paging";
import {
  getErrorGroupDetail,
  listErrorGroups,
  setErrorGroupStatus,
  type ErrorGroupDetail,
  type ErrorGroupItem,
  type ErrorListResult,
} from "./service";

/** Server Actions da tela Admin → Erros. TODAS atrás de `requirePlatformAdmin()`. */

const idSchema = z.string().trim().min(1).max(64);

const listSchema = z.object({
  status: z.enum(["OPEN", "RESOLVED", "IGNORED"]).optional(),
  source: z.enum(["SERVER", "CLIENT"]).optional(),
  ...pagingInputShape,
});

export async function listErrorGroupsAction(filters?: unknown): Promise<Result<ErrorListResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return listErrorGroups(listSchema.parse(filters ?? {}));
  });
}

export async function getErrorGroupAction(id: string): Promise<Result<ErrorGroupDetail>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getErrorGroupDetail(idSchema.parse(id));
  });
}

export async function setErrorGroupStatusAction(id: string, status: unknown): Promise<Result<ErrorGroupItem>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    return setErrorGroupStatus(idSchema.parse(id), z.enum(["OPEN", "RESOLVED", "IGNORED"]).parse(status), admin.id);
  });
}
