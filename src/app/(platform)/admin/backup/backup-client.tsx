"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle2, DatabaseBackup, Link2, PlayCircle, Plug, Save, Unlink } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { HelpButton } from "@/components/help/help-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatDateBR } from "@/modules/billing/format";
import {
  disconnectGoogleAction,
  runBackupNowAction,
  saveBackupConfigAction,
  startGoogleConnectionAction,
  testBackupConnectionAction,
  type BackupPanelData,
} from "@/modules/backup/actions";
import type { BackupRunView } from "@/modules/backup/service";

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

function When({ iso }: { iso: string }) {
  const d = new Date(iso);
  return (
    <>
      <span className="block font-medium tabular-nums text-text">{formatDateBR(d, TZ)}</span>
      <span className="block text-xs tabular-nums text-text-secondary">{formatTimeLabel(d, TZ)}</span>
    </>
  );
}

function RunStatus({ run }: { run: BackupRunView }) {
  if (run.status === "RUNNING") return <Badge variant="primary">Em andamento</Badge>;
  if (run.status === "FAILED") return <Badge variant="danger">Falhou</Badge>;
  // Sucesso sem destino: o dump foi conferido, mas não saiu do servidor.
  return run.objectKey ? <Badge variant="success">Enviado</Badge> : <Badge variant="warning">Só teste</Badge>;
}

export function BackupClient({ data, google }: { data: BackupPanelData; google: { ok: true } | { ok: false; reason: string } | null }) {
  const { config, status, runs } = data;
  const { notify } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isNavigating, startNavigation] = useTransition();
  const [busy, setBusy] = useState<null | "save" | "test" | "run" | "connect" | "disconnect">(null);
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

  const anyBusy = busy !== null;
  const lastSuccess = status.lastSuccessAt ? new Date(status.lastSuccessAt) : null;
  const nextRun = status.nextRunAt ? new Date(status.nextRunAt) : null;

  return (
    <div>
      <PageHeader
        icon={navIconFor("admin/backup")}
        title="Backup do banco"
        description="Cópia diária do banco fora do servidor, com aviso se atrasar."
        help="pagina.adminBackup"
        action={
          <Button type="button" icon={PlayCircle} onClick={handleRunNow} isLoading={busy === "run"} loadingText="Copiando o banco…" disabled={anyBusy}>
            Fazer backup agora
          </Button>
        }
      />

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

      <Card className="mb-4">
        <CardContent className="grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <p className="text-xs text-text-secondary">Última cópia enviada</p>
            <p className="mt-1 font-medium text-text">{lastSuccess ? `${formatDateBR(lastSuccess, TZ)} às ${formatTimeLabel(lastSuccess, TZ)}` : "Nenhuma ainda"}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary">Próxima cópia automática</p>
            <p className="mt-1 font-medium text-text">{nextRun ? `${formatDateBR(nextRun, TZ)} às ${formatTimeLabel(nextRun, TZ)}` : "Automático desligado"}</p>
          </div>
          <div>
            <p className="text-xs text-text-secondary">Situação</p>
            <p className="mt-1">
              {status.running ? (
                <Badge variant="primary">Copiando agora</Badge>
              ) : status.late ? (
                <Badge variant="danger">{status.never ? "Ligado, mas nunca rodou" : "Atrasado"}</Badge>
              ) : config.enabled ? (
                <Badge variant="success">Em dia</Badge>
              ) : (
                <Badge variant="warning">Desligado</Badge>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {!config.destinationReady ? (
        <Alert variant="warning" className="mb-4">
          Enquanto o destino não estiver completo, o automático não liga e Fazer backup agora só gera um teste: a cópia é conferida e descartada, não vale como backup.
        </Alert>
      ) : null}

      <form onSubmit={handleSave}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader help="backup.agendamento">
              <CardTitle>Agendamento</CardTitle>
              <CardDescription>Uma cópia por dia, no horário de Brasília.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p id="backup-enabled-label" className="text-sm font-medium text-text">
                    Backup automático
                  </p>
                  <p id="backup-enabled-hint" className="text-xs text-text-secondary">
                    Desligado, só o botão Fazer backup agora copia o banco.
                  </p>
                </div>
                <Switch checked={enabled} onCheckedChange={setEnabled} aria-labelledby="backup-enabled-label" aria-describedby="backup-enabled-hint" />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
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
            </CardContent>
          </Card>

          <Card>
            <CardHeader help="backup.destino">
              <CardTitle>Destino</CardTitle>
              <CardDescription>Onde as cópias ficam guardadas, fora do servidor do banco.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 p-5">
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
                <div className="space-y-4">
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
                <div className="space-y-4">
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
                      <Field label="Client ID">
                        {(p) => <Input {...p} value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} autoComplete="off" />}
                      </Field>
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
                      <Field label="Arquivo de chave da conta de serviço" hint={config.hasDriveServiceAccount ? "Salvo e escondido. Deixe em branco para manter." : "Cole o conteúdo inteiro do arquivo baixado no Google Cloud."}>
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
            </CardContent>
            <CardFooter className="flex flex-wrap gap-2 p-5">
              <Button type="button" variant="secondary" icon={Plug} onClick={handleTest} isLoading={busy === "test"} loadingText="Testando…" disabled={anyBusy || destination === ""}>
                Testar conexão
              </Button>
            </CardFooter>
          </Card>
        </div>

        <div className="mt-4 flex justify-end">
          <Button type="submit" icon={Save} isLoading={busy === "save"} loadingText="Salvando…" disabled={anyBusy}>
            Salvar configuração
          </Button>
        </div>
      </form>

      <Card className="mt-6">
        <CardHeader help="backup.historico">
          <CardTitle>Histórico</CardTitle>
          <CardDescription>Cada cópia feita ou tentada. As que falharam mostram o motivo.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {runs.totalItems === 0 ? (
            <div className="p-5">
              <EmptyState icon={DatabaseBackup} title="Nenhuma cópia ainda" description="Clique em Fazer backup agora para provar o caminho inteiro antes de ligar o automático." />
            </div>
          ) : (
            <div className={isNavigating ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isNavigating || undefined}>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Quando</TableHeadCell>
                    <TableHeadCell>Situação</TableHeadCell>
                    <TableHeadCell>Origem</TableHeadCell>
                    <TableHeadCell>Destino</TableHeadCell>
                    <TableHeadCell>Tamanho</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {runs.items.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>
                        <When iso={run.startedAt} />
                      </TableCell>
                      <TableCell>
                        <RunStatus run={run} />
                        {run.status === "FAILED" ? (
                          <div className="mt-1 max-w-md">
                            <p className="text-xs font-medium text-danger">{ERROR_LABELS[run.errorCode ?? "UNKNOWN"] ?? ERROR_LABELS.UNKNOWN}</p>
                            {run.errorDetail ? <p className="break-words text-xs text-text-secondary">{run.errorDetail}</p> : null}
                          </div>
                        ) : null}
                        {run.status === "SUCCESS" && !run.objectKey ? <p className="mt-1 text-xs text-text-secondary">Conferida, mas não enviada: sem destino.</p> : null}
                      </TableCell>
                      <TableCell>{run.trigger === "SCHEDULED" ? "Automática" : "Manual"}</TableCell>
                      <TableCell>{run.destination === "S3" ? "Bucket S3" : run.destination === "DRIVE" ? "Google Drive" : "Nenhum"}</TableCell>
                      <TableCell className="tabular-nums">
                        {formatBytes(run.sizeBytes)}
                        {run.tablesWithData !== null ? <span className="block text-xs text-text-secondary">{run.tablesWithData} tabelas</span> : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="p-4">
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
        </CardContent>
      </Card>

      <p className="mt-4 flex items-center gap-2 text-xs text-text-secondary">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        Restaurar não tem botão aqui, de propósito. O passo a passo está no runbook (docs/runbook.md).
      </p>
    </div>
  );
}
