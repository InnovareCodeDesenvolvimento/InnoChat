import { cookies, headers } from "next/headers";
import { clientIp } from "@/lib/http/client-ip";
import type { MetaClientContext } from "./tracking";

/** Lê, no pedido atual, o que a Meta usa para casar o evento: IP, navegador e cookies `_fbp`/`_fbc`. */
export async function readMetaClientContext(): Promise<MetaClientContext> {
  const [jar, h, ip] = await Promise.all([cookies(), headers(), clientIp()]);
  return {
    ip,
    userAgent: h.get("user-agent"),
    fbp: jar.get("_fbp")?.value ?? null,
    fbc: jar.get("_fbc")?.value ?? null,
  };
}
