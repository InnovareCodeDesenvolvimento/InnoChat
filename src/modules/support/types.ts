export type StartSupportInput = {
  tenantId: string;
  reason: string;
};

export type StartSupportOutput = {
  redirectTo: string;
  sessionId: string;
};

export type ExitSupportOutput = {
  closed: boolean;
  redirectTo: string;
};
