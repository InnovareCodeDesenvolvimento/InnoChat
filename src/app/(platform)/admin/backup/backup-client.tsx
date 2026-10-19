"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  CheckCircle2,
  Clock,
  ClipboardCopy,
  DatabaseBackup,
  Download,
  HardDrive,
  KeyRound,
  Link2,
  PlayCircle,
  Plug,
  Save,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { HelpButton } from "@/components/help/help-button";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatDateBR } from "@/modules/billing/format";
import {
  disconnectGoogleAction,
  generateBackupKeyAction,
  runBackupNowAction,
  saveBackupConfigAction,
  startGoogleConnectionAction,
  testBackupConnectionAction,
  verifyBackupAction,
  type BackupPanelData,
} from "@/modules/backup/actions";
import { REPLACE_KEY_CONFIRMATION } from "@/modules/backup/policy";
import type { BackupRunView, GeneratedBackupKey, VerifyResult } from "@/modules/backup/service";
import type { ListRemoteBackupsResult } from "@/modules/backup/restore-types";
import { RemoteBackupsList } from "@/components/admin/backup/remote-backups-list";
import { Panel, RowShell, StatusPill, StatCard, PanelEmptyState, type PillTone } from "@/components/admin/backup/admin-ui";

const TZ = "America/Sao_Paulo";

/** O que o Google devolveu no callback, traduzido. Os códigos vêm de `completeGoogleConnection`. */
const GOOGLE_ERRORS: Record<string, string> = {
  acesso_negado: "Você cancelou a autorização no Google. Clique em Conectar com Google para tentar de novo.",
  estado_invalido: "O link de conexão expirou ou já foi usado. Clique em Conectar com Google de novo.",
  credenciais_invalidas: "O Google recusou o Client ID ou o Client Secret, ou o endereço de retorno não está cadastrado no app. Confira os três.",
  falha_ao_criar_pasta: "A conta conectou, mas não deu para criar a pasta no Drive. Tente de novo.",
  falha_ao_confirmar_conta: "O Google autorizou, mas não confirmou qual é a conta. Tente de novo.",
  sem_refresh_token: "O Google não entregou o acesso permanente. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.",
  sem_codigo: "O Google não devolveu o código de autorização. Tente de novo.",
  recusado_pelo_google: "O Google recusou a autorização. Confira se o app está publicado e se a sua conta pode usá-lo.",
  url_publica: "A URL pública do sistema ainda não está salva. Abra Admin > Configurações uma vez e tente de novo.",
};

const ERROR_LABELS: Record<string, string> = {
  CREDENTIAL: "Chave recusada",
  FOLDER: "Pasta ou bucket inacessível",
  QUOTA: "Sem espaço",
  NETWORK: "Falha de rede",
  OAUTH_DISCONNECTED: "Conta Google desconectada",
  DUMP: "Falha ao copiar o banco",
  CONFIG: "Configuração incompleta",
  BUSY: "Já havia uma cópia rodando",
  KEY: "Problema com a chave",
  NO_BACKUP: "Nenhuma cópia no destino",
  VERIFY: "A cópia não passou na conferência",
  UNKNOWN: "Erro desconhecido",
};

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${formatDateBR(d, TZ)} às ${formatTimeLabel(d, TZ)}`;
}

/** Selo + rótulo da execução, equivalente ao `STATUS_META` do painel de referência. */
function runStatusMeta(run: BackupRunView): { label: string; tone: PillTone } {
  if (run.status === "RUNNING") return { label: "Em andamento", tone: "primary" };
  if (run.status === "FAILED") return { label: run.trigger === "VERIFY" ? "Reprovou" : "Falhou", tone: "danger" };
  if (run.trigger === "VERIFY") return { label: "Conferida", tone: "success" };
  // Sucesso sem destino: o dump foi conferido, mas não saiu do servidor.
  return run.objectKey ? { label: "Enviado", tone: "success" } : { label: "Só teste", tone: "warning" };
}

export function BackupClient({
  data,
  google,
  remoteBackups,
}: {
  data: BackupPanelData;
  google: { ok: true } | { ok: false; reason: string } | null;
  remoteBackups?: ListRemoteBackupsResult;
}) {
  const { config, status, runs } = data;
  const { notify } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isNavigating, startNavigation] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "run" | "connect" | "disconnect" | "key" | "verify">(null);
  /** A chave inteira, só em memória e só até a pessoa dispensar: não vai para URL, storage nem cache. */
  const [revealed, setRevealed] = useState<GeneratedBackupKey | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [proofPassword, setProofPassword] = useState("");
  const [proofCode, setProofCode] = useState("");
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [message, setMessage] = useState<{ variant: "success" | "danger" | "warning"; text: string } | null>(null);

  const [enabled, setEnabled] = useState(config.enabled);
  const [hourLocal, setHourLocal] = useState(String(config.hourLocal));
  const [retentionDays, setRetentionDays] = useState(String(config.retentionDays));
  const [alertAfterHours, setAlertAfterHours] = useState(String(config.alertAfterHours));
  const [destination, setDestination] = useState<"" | "S3" | "DRIVE">(config.destination ?? "");
  const [driveMode, setDriveMode] = useState(config.driveMode);
  const [s3Endpoint, setS3Endpoint] = useState(config.s3Endpoint ?? "");
  const [s3Bucket, setS3Bucket] = useState(config.s3Bucket ?? "");
  const [s3Region, setS3Region] = useState(config.s3Region ?? "");
  const [s3Prefix, setS3Prefix] = useState(config.s3Prefix ?? "");
  const [s3AccessKey, setS3AccessKey] = useState(config.s3AccessKey ?? "");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [driveFolderId, setDriveFolderId] = useState(config.driveFolderId ?? "");
  const [driveServiceAccountKey, setDriveServiceAccountKey] = useState("");
  const [oauthClientId, setOauthClientId] = useState(config.driveOauthClientId ?? "");
  const [oauthClientSecret, setOauthClientSecret] = useState("");

  function buildPayload() {
    return {
      enabled,
      hourLocal: Number(hourLocal),
      retentionDays: Number(retentionDays),
      alertAfterHours: Number(alertAfterHours),
      destination: destination === "" ? null : destination,
      driveMode,
      s3Endpoint,
      s3Bucket,
      s3Region,
      s3Prefix,
      s3AccessKey,
      s3SecretKey: s3SecretKey || undefined,
      driveFolderId,
      driveServiceAccountKey: driveServiceAccountKey || undefined,
      driveOauthClientId: oauthClientId,
      driveOauthClientSecret: oauthClientSecret || undefined,
    };
  }

  /** Salva o formulário inteiro. Devolve `true` se gravou (para encadear teste e conexão). */
  async function save(): Promise<boolean> {
    const result = await saveBackupConfigAction(buildPayload());
    if (!result.ok) {
      setMessage({ variant: "danger", text: result.error.message });
      return false;
    }
    setS3SecretKey("");
    setDriveServiceAccountKey("");
    setOauthClientSecret("");
    router.refresh();
    return true;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy("save");
    setMessage(null);
    if (await save()) notify({ title: "Configuração do backup salva", variant: "success" });
    setBusy(null);
  }

  async function handleTest() {
    setBusy("test");
    setMessage(null);
    // Testa o que está na tela: salva antes, porque o teste usa o que está gravado.
    if (await save()) {
      const result = await testBackupConnectionAction();
      setMessage(result.ok ? { variant: "success", text: result.data.message } : { variant: "danger", text: result.error.message });
    }
    setBusy(null);
  }

  async function handleRunNow() {
    setBusy("run");
    setMessage(null);
    const result = await runBackupNowAction();
    if (!result.ok) {
      setMessage({ variant: "danger", text: result.error.message });
    } else {
      const { sizeBytes, tablesWithData, sentToDestination, message: text } = result.data;
      setMessage({ variant: sentToDestination ? "success" : "warning", text: `${text} ${formatBytes(sizeBytes)}, ${tablesWithData} tabelas com dados.` });
    }
    router.refresh();
    setBusy(null);
  }

  // Enquanto a chave está na tela e a pessoa não dispensou, sair da página perderia a única chance de copiá-la.
  useEffect(() => {
    if (!revealed) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [revealed]);

  async function handleGenerateKey() {
    setBusy("key");
    setMessage(null);
    const result = await generateBackupKeyAction(config.hasEncryptionKey ? { replace: true, confirmation: confirmText, password: proofPassword || undefined, code: proofCode || undefined } : {});
    if (result.ok) {
      setRevealed(result.data);
      setReplacing(false);
      setConfirmText("");
      setProofPassword("");
      setProofCode("");
      router.refresh();
    } else {
      setMessage({ variant: "danger", text: result.error.message });
    }
    setBusy(null);
  }

  async function handleCopyKey() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      notify({ title: "Chave copiada", variant: "success" });
    } catch {
      setMessage({ variant: "warning", text: "O navegador não deixou copiar. Selecione a chave na caixa e copie à mão, ou baixe o arquivo." });
    }
  }

  function handleDownloadKey() {
    if (!revealed) return;
    const url = URL.createObjectURL(new Blob([revealed.fileText], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = revealed.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleVerify() {
    setBusy("verify");
    setMessage(null);
    setVerifyResult(null);
    const result = await verifyBackupAction();
    if (result.ok) setVerifyResult(result.data);
    else setMessage({ variant: "danger", text: result.error.message });
    router.refresh();
    setBusy(null);
  }

  async function handleConnect() {
    setBusy("connect");
    setMessage(null);
    // O Client ID e o Secret precisam estar salvos antes de ir ao Google.
    if (await save()) {
      const result = await startGoogleConnectionAction();
      if (result.ok) {
        window.location.href = result.data.url;
        return;
      }
      setMessage({ variant: "danger", text: result.error.message });
    }
    setBusy(null);
  }

  async function handleDisconnect() {
    setBusy("disconnect");
    setMessage(null);
    const result = await disconnectGoogleAction();
    if (result.ok) {
      notify({ title: "Conta Google desconectada", variant: "success" });
      router.refresh();
    } else {
      setMessage({ variant: "danger", text: result.error.message });
    }
    setBusy(null);
  }

  function goToPage(page: number, pageSize: number) {
    startNavigation(() => router.push(`${pathname}?pagina=${page}&porPagina=${pageSize}`));
  }

  function goToRemotePage(page: number, pageSize: number) {
    startNavigation(() => router.push(`${pathname}?remotoPagina=${page}&remotoPorPagina=${pageSize}`));
  }

  const anyBusy = busy !== null;
  const lastSuccess = status.lastSuccessAt ? new Date(status.lastSuccessAt) : null;
  const nextRun = status.nextRunAt ? new Date(status.nextRunAt) : null;
  const cifraTone: PillTone = config.hasEncryptionKey ? "success" : "warning";

  return (
    <div>
      {/* 1. Cabeçalho — sem ação aqui: "Fazer backup agora" mora no painel de Agendamento,
          junto do botão de ligar/desligar o automático, como no projeto de referência. */}
      <PageHeader icon={navIconFor("admin/backup")} title="Backup do banco" description="Cópia diária do banco fora do servidor, com aviso se atrasar." help="pagina.adminBackup" />

      {/* 2. Avisos — nesta ordem: volta do Google, atraso, destino incompleto. */}
      {google ? (
        google.ok ? (
          <Alert variant="success" className="mb-4">
            Conta Google conectada. Use Fazer backup agora para provar que a pasta recebe o arquivo.
          </Alert>
        ) : (
          <Alert variant="danger" className="mb-4" title="Não deu para conectar a conta Google">
            {GOOGLE_ERRORS[google.reason] ?? "O Google não concluiu a conexão. Tente de novo."}
          </Alert>
        )
      ) : null}

      {message ? (
        <Alert variant={message.variant} className="mb-4" aria-live="polite">
          {message.text}
        </Alert>
      ) : null}

      {status.late ? (
        <Alert variant="danger" className="mb-4" title={status.never ? "O backup está ligado, mas nunca rodou até o fim." : "Sem backup bem-sucedido há tempo demais."}>
          O limite configurado é {config.alertAfterHours}h. Use Fazer backup agora e confira o destino abaixo.
        </Alert>
      ) : null}

      {!config.destinationReady ? (
        <Alert variant="warning" className="mb-4">
          <strong>Um dump guardado no mesmo servidor do banco morre junto com ele.</strong> Enquanto o destino não estiver completo, o automático não liga e Fazer backup agora só gera um teste: a cópia é conferida e descartada, não vale como backup.
        </Alert>
      ) : null}

      {/* 3. Grade de 4 cartões de resumo. */}
      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={Clock}
          label="Última cópia enviada"
          value={lastSuccess ? `${formatDateBR(lastSuccess, TZ)} às ${formatTimeLabel(lastSuccess, TZ)}` : "Nenhuma ainda"}
          tone={status.late ? "danger" : lastSuccess ? "success" : "neutral"}
        />
        <StatCard
          icon={DatabaseBackup}
          label="Próxima cópia automática"
          value={nextRun ? `${formatDateBR(nextRun, TZ)} às ${formatTimeLabel(nextRun, TZ)}` : "Automático desligado"}
          tone={config.enabled ? "primary" : "neutral"}
        />
        <StatCard icon={HardDrive} label="Retenção" value={`${config.retentionDays} dias`} hint="apaga do destino o que passar disso" tone="neutral" />
        <StatCard
          icon={CheckCircle2}
          label="Situação"
          value={
            status.running ? (
              <StatusPill tone="primary">Copiando agora</StatusPill>
            ) : status.late ? (
              <StatusPill tone="danger">{status.never ? "Ligado, mas nunca rodou" : "Atrasado"}</StatusPill>
            ) : config.enabled ? (
              <StatusPill tone="success">Em dia</StatusPill>
            ) : (
              <StatusPill tone="warning">Desligado</StatusPill>
            )
          }
          tone={status.running ? "primary" : status.late ? "danger" : config.enabled ? "success" : "warning"}
        />
      </div>

      {/* 4. Agendamento e Destino, no mesmo formulário (como no projeto de referência, onde
          "Salvar configuração" fica ao final do painel de Destino). */}
      <form onSubmit={handleSave}>
        <div className="grid gap-4">
          <Panel title="Agendamento" description="Uma cópia por dia, no horário de Brasília." help="backup.agendamento">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill tone={enabled ? "success" : "neutral"}>{enabled ? "Automático ligado" : "Automático desligado"}</StatusPill>
              {status.running ? <StatusPill tone="warning">Backup em andamento</StatusPill> : null}
              <div className="ml-auto flex flex-wrap items-center gap-3">
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-labelledby="backup-enabled-label" aria-describedby="backup-enabled-hint" />
                <Button type="button" icon={PlayCircle} onClick={handleRunNow} isLoading={busy === "run"} loadingText="Copiando o banco…" disabled={anyBusy}>
                  Fazer backup agora
                </Button>
              </div>
            </div>
            <p id="backup-enabled-label" className="sr-only">
              Backup automático
            </p>
            <p id="backup-enabled-hint" className="mt-1 text-xs text-text-secondary">
              Desligado, só o botão Fazer backup agora copia o banco.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <Field label="Hora" hint="De 0 a 23, Brasília.">
                {(p) => <Input {...p} type="number" min={0} max={23} value={hourLocal} onChange={(e) => setHourLocal(e.target.value)} />}
              </Field>
              <Field label="Guardar por (dias)" hint="As mais antigas são apagadas.">
                {(p) => <Input {...p} type="number" min={1} max={365} value={retentionDays} onChange={(e) => setRetentionDays(e.target.value)} />}
              </Field>
              <Field label="Avisar após (horas)" hint="Sem cópia nova, de 6 a 720.">
                {(p) => <Input {...p} type="number" min={6} max={720} value={alertAfterHours} onChange={(e) => setAlertAfterHours(e.target.value)} />}
              </Field>
            </div>
          </Panel>

          <Panel title="Destino" description="Onde as cópias ficam guardadas, fora do servidor do banco." help="backup.destino">
            <Field label="Guardar em">
              {(p) => (
                <Select {...p} value={destination} onChange={(e) => setDestination(e.target.value as "" | "S3" | "DRIVE")}>
                  <option value="">Escolha um destino</option>
                  <option value="S3">Bucket S3 (R2, Backblaze, AWS)</option>
                  <option value="DRIVE">Google Drive</option>
                </Select>
              )}
            </Field>

            {destination === "S3" ? (
              <div className="mt-4 space-y-4">
                <Field label="Endereço do bucket" hint="Ex.: https://SEU-ID.r2.cloudflarestorage.com">
                  {(p) => <Input {...p} value={s3Endpoint} onChange={(e) => setS3Endpoint(e.target.value)} placeholder="https://" autoComplete="off" />}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Bucket">{(p) => <Input {...p} value={s3Bucket} onChange={(e) => setS3Bucket(e.target.value)} autoComplete="off" />}</Field>
                  <Field label="Região" hint="No R2, use auto.">
                    {(p) => <Input {...p} value={s3Region} onChange={(e) => setS3Region(e.target.value)} placeholder="auto" autoComplete="off" />}
                  </Field>
                </div>
                <Field label="Pasta dentro do bucket (opcional)">
                  {(p) => <Input {...p} value={s3Prefix} onChange={(e) => setS3Prefix(e.target.value)} placeholder="banco" autoComplete="off" />}
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Chave de acesso">{(p) => <Input {...p} value={s3AccessKey} onChange={(e) => setS3AccessKey(e.target.value)} autoComplete="off" />}</Field>
                  <Field label="Segredo" hint={config.hasS3Secret ? "Salvo e escondido. Deixe em branco para manter." : undefined}>
                    {(p) => (
                      <Input
                        {...p}
                        type="password"
                        value={s3SecretKey}
                        onChange={(e) => setS3SecretKey(e.target.value)}
                        placeholder={config.hasS3Secret ? "••••••••" : ""}
                        autoComplete="new-password"
                      />
                    )}
                  </Field>
                </div>
              </div>
            ) : null}

            {destination === "DRIVE" ? (
              <div className="mt-4 space-y-4">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-text">Como acessar o Drive</p>
                  <HelpButton helpKey="backup.drive" placement="inline" />
                </div>
                <Field label="Acesso">
                  {(p) => (
                    <Select {...p} value={driveMode} onChange={(e) => setDriveMode(e.target.value as "SERVICE_ACCOUNT" | "OAUTH")}>
                      <option value="OAUTH">Conectar com Google (Gmail pessoal)</option>
                      <option value="SERVICE_ACCOUNT">Conta de serviço (Google Workspace)</option>
                    </Select>
                  )}
                </Field>

                {driveMode === "OAUTH" ? (
                  <div className="space-y-4">
                    <Field label="Client ID">{(p) => <Input {...p} value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} autoComplete="off" />}</Field>
                    <Field label="Client Secret" hint={config.hasDriveOauthClientSecret ? "Salvo e escondido. Deixe em branco para manter." : undefined}>
                      {(p) => (
                        <Input
                          {...p}
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder={config.hasDriveOauthClientSecret ? "••••••••" : ""}
                          autoComplete="new-password"
                        />
                      )}
                    </Field>
                    {config.driveOauthConnected ? (
                      <Alert variant="success">
                        Conectado como <strong>{config.driveOauthEmail}</strong>. As cópias vão para a pasta &quot;Backups InnoChat&quot; do Drive dessa conta.
                      </Alert>
                    ) : (
                      <Alert variant="info">
                        Ainda não conectado. No Google Cloud, cadastre este endereço de retorno no app: <code className="break-all">/api/admin/backup/google/callback</code> (com o endereço público do sistema na frente).
                      </Alert>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="secondary" icon={Link2} onClick={handleConnect} isLoading={busy === "connect"} loadingText="Abrindo o Google…" disabled={anyBusy}>
                        {config.driveOauthConnected ? "Reconectar com Google" : "Conectar com Google"}
                      </Button>
                      {config.driveOauthConnected ? (
                        <Button type="button" variant="ghost" icon={Unlink} onClick={handleDisconnect} isLoading={busy === "disconnect"} loadingText="Desconectando…" disabled={anyBusy}>
                          Desconectar
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <Field label="Pasta do Drive" hint="Cole o link da pasta ou o id dela. Compartilhe a pasta como Editor com o e-mail abaixo.">
                      {(p) => <Input {...p} value={driveFolderId} onChange={(e) => setDriveFolderId(e.target.value)} placeholder="https://drive.google.com/drive/folders/..." autoComplete="off" />}
                    </Field>
                    <Field
                      label="Arquivo de chave da conta de serviço"
                      hint={config.hasDriveServiceAccount ? "Salvo e escondido. Deixe em branco para manter." : "Cole o conteúdo inteiro do arquivo baixado no Google Cloud."}
                    >
                      {(p) => (
                        <Textarea
                          {...p}
                          rows={4}
                          value={driveServiceAccountKey}
                          onChange={(e) => setDriveServiceAccountKey(e.target.value)}
                          placeholder={config.hasDriveServiceAccount ? "••••••••" : '{ "type": "service_account", ... }'}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      )}
                    </Field>
                    {config.driveClientEmail ? (
                      <Alert variant="info">
                        Compartilhe a pasta, como Editor, com: <strong className="break-all">{config.driveClientEmail}</strong>
                      </Alert>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}

            <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
              <Button type="button" variant="secondary" icon={Plug} onClick={handleTest} isLoading={busy === "test"} loadingText="Testando…" disabled={anyBusy || destination === ""}>
                Testar conexão
              </Button>
              <Button type="submit" icon={Save} isLoading={busy === "save"} loadingText="Salvando…" disabled={anyBusy}>
                Salvar configuração
              </Button>
            </div>
          </Panel>
        </div>
      </form>

      {/* 5. Cifra: mostrada sempre, em qualquer estado da chave — backup em claro é
          o banco inteiro legível para quem alcançar o destino. */}
      <Panel className="mt-4" title="Chave do backup" description="As cópias saem do servidor trancadas com uma chave que só você guarda." help="backup.criptografia" action={<StatusPill tone={cifraTone}>{config.hasEncryptionKey ? "Cifrados" : "Sem cifra"}</StatusPill>}>
        {revealed ? (
          <div className="space-y-3">
            <Alert variant="warning" title="Guarde fora do servidor. Sem ela os backups não abrem.">
              Esta é a única vez que a chave aparece inteira. Se fechar esta tela sem guardar, só dá para gerar outra, e as cópias feitas com esta ficam sem como abrir.
            </Alert>
            <div>
              <p className="text-xs text-text-secondary">Chave (impressão digital {revealed.fingerprint})</p>
              <code data-testid="backup-key" className="mt-1 block break-all rounded-card border border-border bg-bg p-3 font-mono text-sm text-text select-all">
                {revealed.key}
              </code>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" icon={ClipboardCopy} onClick={handleCopyKey}>
                Copiar chave
              </Button>
              <Button type="button" variant="secondary" icon={Download} onClick={handleDownloadKey}>
                Baixar arquivo .txt
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRevealed(null)}>
                Já guardei, esconder
              </Button>
            </div>
          </div>
        ) : config.hasEncryptionKey ? (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-text-secondary">Impressão digital da chave atual</p>
              <p className="mt-1 font-mono text-lg font-medium text-text" data-testid="backup-key-fingerprint">
                {config.encryptionKeyFingerprint}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {config.encryptionKeyCreatedAt
                  ? `Gerada em ${formatDateBR(new Date(config.encryptionKeyCreatedAt), TZ)} às ${formatTimeLabel(new Date(config.encryptionKeyCreatedAt), TZ)}. `
                  : ""}
                Confira se é a mesma do arquivo que você guardou. A chave em si não aparece de novo.
              </p>
            </div>
            {replacing ? (
              <div className="space-y-3 rounded-card border border-danger/40 bg-danger-bg p-4">
                <p className="text-sm text-text">
                  Uma chave nova não abre as cópias que já existem: elas continuam precisando da chave antiga, e o sistema não guarda a antiga. Só troque se a chave atual vazou ou se você já tem as duas guardadas.
                </p>
                <Field label={`Para confirmar, digite ${REPLACE_KEY_CONFIRMATION}`}>
                  {(p) => <Input {...p} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />}
                </Field>
                <p className="text-sm text-text">Para garantir que é você, informe sua senha ou um código do app de verificação em 2 etapas.</p>
                <Field label="Sua senha">
                  {(p) => <Input {...p} type="password" value={proofPassword} onChange={(e) => setProofPassword(e.target.value)} autoComplete="current-password" />}
                </Field>
                <Field label="Ou o código do app (6 dígitos)">
                  {(p) => <Input {...p} value={proofCode} onChange={(e) => setProofCode(e.target.value)} autoComplete="one-time-code" inputMode="numeric" />}
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    icon={KeyRound}
                    onClick={handleGenerateKey}
                    isLoading={busy === "key"}
                    loadingText="Gerando…"
                    disabled={anyBusy || confirmText.trim() !== REPLACE_KEY_CONFIRMATION || (!proofPassword && !proofCode)}
                  >
                    Trocar a chave
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setReplacing(false);
                      setConfirmText("");
                      setProofPassword("");
                      setProofCode("");
                    }}
                    disabled={anyBusy}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            ) : (
              <Button type="button" variant="secondary" icon={KeyRound} onClick={() => setReplacing(true)} disabled={anyBusy}>
                Gerar nova chave
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <Alert variant="warning">Ainda não há chave. Sem ela o backup não sai do servidor e o automático não liga.</Alert>
            <Button type="button" icon={KeyRound} onClick={handleGenerateKey} isLoading={busy === "key"} loadingText="Gerando…" disabled={anyBusy}>
              Gerar chave
            </Button>
          </div>
        )}
      </Panel>

      {/* 6. Conferir backup: sem equivalente direto no projeto de referência — função própria
          do InnoChat, mantida no mesmo estilo de painel. */}
      <Panel className="mt-4" title="Conferir backup" description="Baixa a cópia mais recente, abre com a chave e lê o conteúdo. Não mexe no banco." help="backup.conferir">
        <Button type="button" variant="secondary" icon={ShieldCheck} onClick={handleVerify} isLoading={busy === "verify"} loadingText="Conferindo a cópia…" disabled={anyBusy || !config.destinationReady}>
          Conferir backup
        </Button>
        {!config.destinationReady ? <p className="mt-2 text-xs text-text-secondary">Complete o destino para poder conferir.</p> : null}
        {verifyResult ? (
          <Alert variant="success" className="mt-3" aria-live="polite" title="A cópia está íntegra">
            {`A cópia de ${formatDateBR(new Date(verifyResult.fileCreatedAt), TZ)} às ${formatTimeLabel(new Date(verifyResult.fileCreatedAt), TZ)} (${formatBytes(verifyResult.sizeBytes)}) foi baixada, ${
              verifyResult.encrypted ? `abriu com a chave ${verifyResult.keyFingerprint}, a verificação de integridade passou` : "estava sem cifra (é de antes da criptografia)"
            } e o dump lista ${verifyResult.tablesWithData} tabelas com dados. Nada foi restaurado.`}
          </Alert>
        ) : null}
        <p className="mt-3 text-xs text-text-secondary">Uma vez por semana o sistema faz isso sozinho e avisa por e-mail se a cópia não abrir.</p>
      </Panel>

      {/* 7. Execuções — inclui as que falharam, é nelas que está a informação útil. */}
      <Panel className="mt-4" title="Execuções" description="Cada cópia feita ou tentada. As que falharam mostram o motivo." help="backup.historico" bodyClassName="p-0">
        {runs.totalItems === 0 ? (
          <PanelEmptyState icon={DatabaseBackup} title="Nenhuma cópia ainda" description="Clique em Fazer backup agora para provar o caminho inteiro antes de ligar o automático." />
        ) : (
          <div className={isNavigating ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isNavigating || undefined}>
            <div className="divide-y divide-border" role="list" aria-label="Execuções de backup">
              {runs.items.map((run) => {
                const meta = runStatusMeta(run);
                return (
                  <RowShell
                    key={run.id}
                    actions={
                      <span className="font-mono text-sm tabular-nums text-text">
                        {formatBytes(run.sizeBytes)}
                        {run.tablesWithData !== null ? <span className="ml-2 text-xs text-text-secondary">{run.tablesWithData} tabelas</span> : null}
                      </span>
                    }
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                        <StatusPill tone={run.trigger === "SCHEDULED" ? "neutral" : "info"}>{run.trigger === "SCHEDULED" ? "Automática" : run.trigger === "VERIFY" ? "Conferência" : "Manual"}</StatusPill>
                        {run.destination ? <StatusPill tone="neutral">{run.destination === "DRIVE" ? "Google Drive" : "Bucket S3"}</StatusPill> : null}
                        {run.keyFingerprint ? <StatusPill tone="success">Cifrada · {run.keyFingerprint}</StatusPill> : null}
                      </div>
                      <p className="mt-1 text-xs tabular-nums text-text-secondary">{formatWhen(run.startedAt)}</p>
                      {run.status === "FAILED" ? (
                        <div className="mt-1 max-w-md">
                          <p className="text-xs font-medium text-danger">{ERROR_LABELS[run.errorCode ?? "UNKNOWN"] ?? ERROR_LABELS.UNKNOWN}</p>
                          {run.errorDetail ? <p className="break-words text-xs text-text-secondary">{run.errorDetail}</p> : null}
                        </div>
                      ) : null}
                      {run.status === "SUCCESS" && run.trigger !== "VERIFY" && !run.objectKey ? <p className="mt-1 text-xs text-text-secondary">Conferida, mas não enviada: sem destino.</p> : null}
                    </div>
                  </RowShell>
                );
              })}
            </div>
            <div className="border-t border-border p-4">
              <Pagination
                label="Paginação do histórico de backups"
                page={runs.page}
                pageSize={runs.pageSize}
                totalItems={runs.totalItems}
                totalPages={runs.totalPages}
                isPending={isNavigating}
                onPageChange={(p) => goToPage(p, runs.pageSize)}
                onPageSizeChange={(size) => goToPage(1, size)}
              />
            </div>
          </div>
        )}
      </Panel>

      {/* 8. Cópias remotas — mesmo padrão de painel/linha. */}
      <RemoteBackupsList
        data={
          remoteBackups ?? {
            items: [],
            page: 1,
            pageSize: 10,
            totalItems: 0,
            totalPages: 0,
          }
        }
        destinationReady={config.destinationReady}
        destinationName={config.destination === "DRIVE" ? "Google Drive" : config.destination === "S3" ? "Bucket S3" : "armazenamento remoto"}
        onPageChange={(p) => goToRemotePage(p, remoteBackups?.pageSize ?? 10)}
        onPageSizeChange={(size) => goToRemotePage(1, size)}
        isPending={isNavigating}
      />

      <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Restaurar não tem botão aqui, de propósito. O passo a passo está no runbook (docs/runbook.md).
      </p>
    </div>
  );
}
