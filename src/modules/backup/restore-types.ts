export type RemoteBackupSource = "DRIVE" | "S3";

export type RemoteBackupItem = {
  ref: string;
  name: string;
  sizeBytes: number | null;
  createdAt: string;
  keyFingerprint: string | null;
  source: RemoteBackupSource;
};

export type ListRemoteBackupsResult = {
  items: RemoteBackupItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type ProbeKeyMode = "SYSTEM" | "CUSTOM";

export type ProbeBackupInput = {
  ref: string;
  keyMode: ProbeKeyMode;
  customKeyHex?: string | null;
};

export type ProbeBackupResult = {
  valid: boolean;
  fingerprint: string | null;
  tablesWithData: number;
  uncompressedSizeBytes: number;
  matchesCurrentSystemKey: boolean;
  warning?: string;
};
