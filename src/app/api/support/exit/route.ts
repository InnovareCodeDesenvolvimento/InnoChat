import { NextRequest, NextResponse } from "next/server";
import { clearSupportCookie, getSupportCookieValue } from "@/modules/support/cookie";
import { closeSupportSession, validateSupportSession } from "@/modules/support/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const cookieValue = await getSupportCookieValue();
  let tenantIdForRedirect = "";

  if (cookieValue) {
    const validation = await validateSupportSession({ cookieValue });
    if (validation.ok) {
      tenantIdForRedirect = validation.tenantId;
      await closeSupportSession({
        sessionId: validation.sessionId,
        reason: "EXITED",
      });
    } else if (validation.tenantId) {
      tenantIdForRedirect = validation.tenantId;
    }
  }

  await clearSupportCookie();

  const destination = tenantIdForRedirect
    ? `/admin/empresas/${tenantIdForRedirect}`
    : "/admin/empresas";

  return NextResponse.redirect(new URL(destination, request.url));
}
