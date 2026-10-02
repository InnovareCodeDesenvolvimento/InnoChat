/**
 * Regras puras do backup (sem banco, sem rede): fáceis de testar, e é aqui que se decide o que uma
 * pessoa vai ler às três da manhã. Abordagem portada do Parque das Feiras (docs/BACKUP.md).
 */

export const BACKUP_DESTINATIONS = ["S3", "DRIVE"] as const;
export type BackupDestination = (typeof BACKUP_DESTINATIONS)[number];

export const DRIVE_MODES = ["SERVICE_ACCOUNT", "OAUTH"] as const;
export type DriveMode = (typeof DRIVE_MODES)[number];

/** Códigos de causa gravados em `BackupRun.errorCode`. */
export type BackupErrorCode =
  | "CREDENTIAL"
  | "FOLDER"
  | "QUOTA"
  | "NETWORK"
  | "OAUTH_DISCONNECTED"
  | "DUMP"
  | "CONFIG"
  | "BUSY"
  | "KEY"
  | "NO_BACKUP"
  | "VERIFY"
  | "UNKNOWN";

/** Brasil não tem horário de verão desde 2019: o deslocamento de Brasília é fixo. */
export const BRASILIA_UTC_OFFSET_HOURS = 3;
/** Uma tentativa por dia: o agendador ignora a hora se já houve tentativa nas últimas ~20 h. */
export const REPEAT_WINDOW_MS = 20 * 60 * 60 * 1000;
/** Trava de execução mais velha que isto é tratada como abandonada (processo morreu no meio do dump). */
export const LOCK_EXPIRES_MS = 2 * 60 * 60 * 1000;
/** Frase que a pessoa digita para trocar uma chave que já existe. Trocar é raro e perder a antiga é definitivo. */
export const REPLACE_KEY_CONFIRMATION = "GERAR NOVA CHAVE";
/** A conferência automática da cópia mais recente roda no máximo uma vez por semana (tentativa que falhou também conta). */
export const VERIFY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Conferência que ficou RUNNING além disto morreu no meio. */
export const VERIFY_STALE_MS = 30 * 60 * 1000;
/** Intervalo mínimo entre dois e-mails de "backup atrasado". */
export const LATE_ALERT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** O que as regras precisam de `BackupConfig` (estrutural, para não depender do tipo gerado). */
export type BackupConfigFields = {
  enabled: boolean;
  hourLocal: number;
  retentionDays: number;
  alertAfterHours: number;
  destination: string | null;
  driveMode: string;
  s3Endpoint: string | null;
  s3Bucket: string | null;
  s3AccessKey: string | null;
  s3SecretKeyEnc: string | null;
  driveFolderId: string | null;
  driveServiceAccountEnc: string | null;
  driveOauthClientId: string | null;
  driveOauthClientSecretEnc: string | null;
  driveOauthRefreshTokenEnc: string | null;
  driveOauthFolderId: string | null;
  driveOauthConnectedAt: Date | null;
  lastSuccessAt: Date | null;
  lastAttemptAt: Date | null;
};

/**
 * Qual destino está ATIVO e completo, ou `null` se o dump não sai do servidor. O destino escolhido
 * manda: nunca se infere pelos campos preenchidos (com os dois preenchidos, a dedução escolheria
 * sozinha, e limpar um campo passaria a mudar o destino do backup sem ninguém ter mandado).
 * "Client ID preenchido" NÃO é "conectado": só `driveOauthConnectedAt` prova que o fluxo terminou.
 */
export function activeDestination(config: BackupConfigFields): BackupDestination | null {
  if (config.destination === "S3") {
    return config.s3Endpoint && config.s3Bucket && config.s3AccessKey && config.s3SecretKeyEnc ? "S3" : null;
  }
  if (config.destination === "DRIVE") {
    if (config.driveMode === "OAUTH") {
      return config.driveOauthConnectedAt && config.driveOauthRefreshTokenEnc && config.driveOauthFolderId ? "DRIVE" : null;
    }
    return config.driveFolderId && config.driveServiceAccountEnc ? "DRIVE" : null;
  }
  return null;
}

const FILE_PREFIX = "backup-";

/** `backup-innochat-2026-10-02-09h24m40s.dump`, hora de Brasília (a que o dono lê no relógio). Segundos evitam colisão no S3. */
export function backupFileName(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${FILE_PREFIX}innochat-${parts.year}-${parts.month}-${parts.day}-${parts.hour}h${parts.minute}m${parts.second}s.dump`;
}

/** Nome do arquivo cifrado: o do dump + `.enc` (`backup-innochat-...dump.enc`). */
export function encryptedBackupFileName(dumpName: string): string {
  return `${dumpName}.enc`;
}

/** É nosso arquivo de backup (cifrado ou do tempo em que não era)? A poda só toca no que passa por aqui. */
export function isBackupFileName(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && (name.endsWith(".dump") || name.endsWith(".dump.enc"));
}

/** A última tentativa de conferência foi há mais de uma semana (ou nunca houve)? */
export function isVerifyDue(lastVerifyAt: Date | null, now: Date): boolean {
  return !lastVerifyAt || now.getTime() - lastVerifyAt.getTime() >= VERIFY_INTERVAL_MS;
}

/** É a hora marcada (Brasília), e ainda não houve tentativa nas últimas ~20 h? */
export function isDue(config: Pick<BackupConfigFields, "enabled" | "hourLocal" | "lastAttemptAt">, now: Date = new Date()): boolean {
  if (!config.enabled) return false;
  const targetUtcHour = (config.hourLocal + BRASILIA_UTC_OFFSET_HOURS) % 24;
  if (now.getUTCHours() !== targetUtcHour) return false;
  const last = config.lastAttemptAt?.getTime() ?? 0;
  return now.getTime() - last >= REPEAT_WINDOW_MS;
}

export type PruneCandidate = { id: string; createdAt: Date };

/**
 * Decide o que apagar (S3 e Drive). Duas guardas que valem mais que a poda:
 * 1. o arquivo recém-enviado JAMAIS é candidato (mesmo que a data diga o contrário, ex.: relógio errado);
 * 2. se apagar todos os candidatos deixaria o destino sem NENHUM backup, não apaga nada. É o caso do
 *    backup que parou de rodar há um mês: a poda diligente jogaria fora a última cópia existente.
 * `keep` nulo = o novo não foi confirmado, e sem confirmação não se apaga nada.
 */
export function decidePrune(items: PruneCandidate[], opts: { retentionDays: number; keep: string | null; now?: Date }): string[] {
  if (!opts.keep) return [];
  const limit = (opts.now ?? new Date()).getTime() - opts.retentionDays * 24 * 60 * 60 * 1000;
  const old = items.filter((i) => i.id !== opts.keep && i.createdAt.getTime() < limit);
  if (old.length === 0) return [];
  if (old.length >= items.length) return [];
  return old.map((i) => i.id);
}

/** Variáveis de ambiente para o `pg_dump`. A senha vai por ENV: argumento de processo é legível por qualquer `ps`. */
export function pgEnvFromUrl(databaseUrl: string): Record<string, string> {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL inválida: não deu para interpretar o endereço do banco.");
  }
  const env: Record<string, string> = {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  // Banco que exige TLS recusa o pg_dump sem isto, e o erro não diz que o motivo foi o SSL.
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

/** Versão principal de "pg_dump (PostgreSQL) 18.1". */
export function parsePgDumpMajor(output: string): number | null {
  const m = output.match(/(\d+)(?:\.\d+)?/);
  return m ? Number(m[1]) : null;
}

/** Mensagem acionável quando o cliente da imagem é mais velho que o servidor. `null` = tudo certo. */
export function pgVersionProblem(clientMajor: number, serverMajor: number): string | null {
  if (serverMajor > 0 && clientMajor < serverMajor) {
    return `O pg_dump da imagem (versão ${clientMajor}) é mais antigo que o servidor do banco (versão ${serverMajor}) e se recusa a copiar. É preciso atualizar o cliente do PostgreSQL no Dockerfile para a versão ${serverMajor} ou mais nova.`;
  }
  return null;
}

/** Quantas tabelas com dados o índice do dump lista (`pg_restore --list`). */
export function countTablesWithData(restoreList: string): number {
  return (restoreList.match(/TABLE DATA/g) ?? []).length;
}

export type LateStatus = { late: boolean; never: boolean; ageHours: number | null; lateSince: Date | null };

/**
 * Backup atrasado? Só vale com o automático ligado. "Nunca rodou" conta como atrasado quando o
 * limite passou desde a última alteração da configuração (`since`, normalmente `updatedAt`), para
 * não alertar no minuto em que alguém liga o agendamento.
 */
export function lateStatus(
  config: Pick<BackupConfigFields, "enabled" | "alertAfterHours" | "lastSuccessAt">,
  now: Date,
  since: Date | null,
): LateStatus {
  if (!config.enabled) return { late: false, never: false, ageHours: null, lateSince: null };
  const limitMs = config.alertAfterHours * 60 * 60 * 1000;
  if (config.lastSuccessAt) {
    const age = now.getTime() - config.lastSuccessAt.getTime();
    return {
      late: age >= limitMs,
      never: false,
      ageHours: Math.floor(age / 3_600_000),
      lateSince: age >= limitMs ? new Date(config.lastSuccessAt.getTime() + limitMs) : null,
    };
  }
  const anchor = since ?? now;
  const late = now.getTime() - anchor.getTime() >= limitMs;
  return { late, never: true, ageHours: null, lateSince: late ? new Date(anchor.getTime() + limitMs) : null };
}

export type AlertMail = { subject: string; text: string; html: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mailOf(subject: string, paragraphs: string[], adminUrl: string | null): AlertMail {
  const link = adminUrl ? `${adminUrl.replace(/\/$/, "")}/admin/backup` : null;
  const lines = [...paragraphs, ...(link ? [`Tela de backup: ${link}`] : [])];
  return {
    subject,
    text: lines.join("\n\n"),
    html: lines.map((l) => `<p>${escapeHtml(l)}</p>`).join(""),
  };
}

const FAILURE_SUBJECT: Partial<Record<BackupErrorCode, string>> = {
  CREDENTIAL: "O backup parou: a chave do Google Drive não é mais aceita",
  FOLDER: "O backup parou: a pasta do Google Drive não está acessível",
  QUOTA: "O backup parou: não há espaço no Google Drive",
  NETWORK: "O backup falhou ao falar com o destino",
  OAUTH_DISCONNECTED: "O backup parou: a conta Google foi desconectada",
  KEY: "O backup parou: falta a chave de criptografia",
};

/** E-mail de falha do backup agendado. A causa vai no assunto (o que se lê no celular) e a ação no corpo. */
export function failureMail(opts: { code: BackupErrorCode; detail: string; destination: BackupDestination | null; adminUrl: string | null }): AlertMail {
  return mailOf(
    FAILURE_SUBJECT[opts.code] ?? "O backup automático do banco falhou",
    [
      `A cópia automática do banco não terminou: ${opts.detail}`,
      "Enquanto isso não for resolvido, o banco está sem cópia nova. Perder o banco é o único incidente que não tem como desfazer.",
    ],
    opts.adminUrl,
  );
}

/** E-mail de backup atrasado. */
export function lateMail(opts: { status: LateStatus; alertAfterHours: number; adminUrl: string | null }): AlertMail {
  const { status } = opts;
  return mailOf(
    status.never ? "O backup automático está ligado, mas nunca rodou" : "O backup do banco está atrasado",
    [
      status.never
        ? `O backup automático está ligado e ainda não houve nenhuma cópia enviada para fora do servidor. O limite configurado é de ${opts.alertAfterHours} horas. Confira o destino na tela de backup e use Fazer backup agora.`
        : `Faz ${status.ageHours} horas desde a última cópia bem-sucedida, e o limite configurado é de ${opts.alertAfterHours} horas. Se o sistema ficou fora do ar, nenhuma cópia foi feita nesse período.`,
      "Trate como incidente, não como aviso: o agendador roda dentro do próprio sistema, então este e-mail é o sinal de que ele não funcionou.",
    ],
    opts.adminUrl,
  );
}

/** E-mail ao conectar ou trocar a conta Google: o dump (todos os clientes) passa a ir para o Drive de quem clicou. */
export function googleConnectedMail(opts: { adminName: string; adminEmail: string; previousEmail: string | null; newEmail: string; adminUrl: string | null }): AlertMail {
  const swap = Boolean(opts.previousEmail) && opts.previousEmail !== opts.newEmail;
  return mailOf(
    swap ? "Backup: a conta Google do backup foi trocada" : "Backup: uma conta Google foi conectada ao backup automático",
    [
      swap
        ? `${opts.adminName} (${opts.adminEmail}) trocou a conta Google do backup automático, de ${opts.previousEmail} para ${opts.newEmail}. A partir de agora a cópia do banco, com os dados de todas as empresas, vai para o Drive da conta nova.`
        : `${opts.adminName} (${opts.adminEmail}) conectou a conta Google ${opts.newEmail} ao backup automático. A partir de agora a cópia do banco, com os dados de todas as empresas, vai para o Drive dessa conta a cada execução.`,
      "Se não foi você nem alguém da sua equipe, desconecte a conta na tela de backup e troque a senha do administrador.",
    ],
    opts.adminUrl,
  );
}

/** E-mail ao desconectar a conta Google. */
export function googleDisconnectedMail(opts: { adminName: string; adminEmail: string; account: string | null; adminUrl: string | null }): AlertMail {
  return mailOf(
    "Backup: a conta Google foi desconectada",
    [
      `${opts.adminName} (${opts.adminEmail}) desconectou a conta Google (${opts.account ?? "desconhecida"}) do backup automático. Sem uma conta conectada, o backup agendado falha por falta de destino até alguém conectar de novo.`,
    ],
    opts.adminUrl,
  );
}

/** E-mail quando a chave de criptografia do backup é gerada ou trocada. Nunca leva a chave. */
export function backupKeyChangedMail(opts: { adminName: string; adminEmail: string; fingerprint: string; replaced: boolean; adminUrl: string | null }): AlertMail {
  return mailOf(
    opts.replaced ? "Backup: a chave de criptografia foi trocada" : "Backup: foi gerada a chave de criptografia",
    [
      opts.replaced
        ? `${opts.adminName} (${opts.adminEmail}) gerou uma chave nova para os backups (impressão digital ${opts.fingerprint}). As cópias feitas daqui em diante só abrem com ela. As cópias antigas continuam precisando da chave antiga: quem a perdeu não consegue abri-las.`
        : `${opts.adminName} (${opts.adminEmail}) gerou a chave de criptografia dos backups (impressão digital ${opts.fingerprint}). Sem essa chave, nenhuma cópia abre.`,
      "Se não foi você nem alguém da sua equipe, troque a senha do administrador.",
    ],
    opts.adminUrl,
  );
}

/** E-mail quando a conferência semanal da cópia mais recente reprova. */
export function verifyFailureMail(opts: { detail: string; adminUrl: string | null }): AlertMail {
  return mailOf(
    "Backup: a conferência da cópia mais recente reprovou",
    [
      `O sistema baixou a cópia mais recente, abriu e tentou ler o conteúdo, e não deu certo: ${opts.detail}`,
      "Trate como incidente: uma cópia que não abre não é backup. Abra a tela de backup, confira a chave e use Fazer backup agora e depois Conferir backup.",
    ],
    opts.adminUrl,
  );
}
