/**
 * Textos em português do registro de auditoria: o nome de cada ação, as áreas do filtro, o nome de cada campo e como
 * mostrar o valor do "de/para". Puro (sem banco): serve ao servidor, às telas e aos testes.
 */

export const ACTION_LABELS: Record<string, string> = {
  "appointment.created": "Agendamento criado",
  "appointment.rescheduled": "Agendamento remarcado",
  "appointment.canceled": "Agendamento cancelado",
  "appointment.completed": "Atendimento concluído",
  "appointment.no_show": "Falta registrada",
  "appointment.reopened": "Atendimento reaberto",
  "service.created": "Serviço criado",
  "service.updated": "Serviço alterado",
  "service.price_changed": "Preço de serviço alterado",
  "service.deleted": "Serviço excluído",
  "professional.created": "Profissional cadastrado",
  "professional.updated": "Profissional alterado",
  "professional.deleted": "Profissional excluído",
  "professional.services_changed": "Serviços do profissional alterados",
  "professional.commission_changed": "Comissão alterada",
  "working_hours.changed": "Horário de funcionamento alterado",
  "schedule_block.created": "Bloqueio ou feriado criado",
  "schedule_block.deleted": "Bloqueio ou feriado removido",
  "settings.theme_changed": "Tema do painel alterado",
  "settings.document_changed": "CPF ou CNPJ alterado",
  "settings.bot_rules_changed": "Regras do bot alteradas",
  "settings.billing_contact_changed": "Contato de cobrança alterado",
  "team.invited": "Convite para a equipe",
  "bot_text.changed": "Mensagem do bot editada",
  "bot_text.reset": "Mensagem do bot restaurada",
  "bot_flow.published": "Fluxo do bot publicado",
  "bot_flow.rolled_back": "Fluxo do bot revertido",
  "subscription.plan_changed": "Plano da assinatura alterado",
  "subscription.cancel_requested": "Cancelamento da assinatura",
  "subscription.cancel_undone": "Cancelamento desfeito",
  "subscription.reactivation_started": "Reativação da assinatura",
  "subscription.coupon_applied": "Cupom aplicado",
  "subscription.cycle_changed": "Ciclo da assinatura alterado",
  "coupon.created": "Cupom criado",
  "coupon.updated": "Cupom alterado",
  "coupon.activated": "Cupom ativado",
  "coupon.deactivated": "Cupom desativado",
  "plan.price_changed": "Preço de plano alterado",
  "plan.updated": "Plano alterado",
  "company.suspended": "Empresa suspensa",
  "company.reactivated": "Empresa reativada",
  "company.trial_extended": "Teste estendido",
  "company.billing_contact_changed": "Contato de cobrança corrigido pela plataforma",
  "invoice.marked_paid_manually": "Baixa manual de fatura",
  "platform.settings_changed": "Configurações da plataforma alteradas",
  "platform.public_base_url_changed": "Endereço público do painel alterado",
  "platform.internal_secret_regenerated": "Segredo da API interna renovado",
  "platform.mercadopago_credentials_changed": "Credenciais do Mercado Pago alteradas",
  "platform.mercadopago_secret_removed": "Segredo do Mercado Pago removido",
  "platform.mercadopago_environment_changed": "Ambiente do Mercado Pago alterado",
  "platform.mercadopago_enabled_changed": "Cobrança pelo Mercado Pago ligada ou desligada",
  "platform.n8n_synced": "n8n sincronizado",
  "platform.bot_workflow_activated": "Fluxo do bot ativado no n8n",
  "platform.bot_workflow_deactivated": "Fluxo do bot desativado no n8n",
  "platform.legal_info_changed": "Dados jurídicos alterados",
  "platform.sales_whatsapp_changed": "WhatsApp comercial alterado",
  "platform.google_login_changed": "Login com Google alterado",
  "platform.google_secret_removed": "Segredo do login com Google removido",
  "platform_whatsapp.enabled_changed": "Avisos pelo WhatsApp da plataforma",
  "platform_whatsapp.connection_started": "Conexão de número iniciada",
  "platform_whatsapp.connection_canceled": "Conexão de número cancelada",
  "platform_whatsapp.disconnected": "Número da plataforma desconectado",
  "pixel.config_changed": "Pixel do Meta alterado",
  "pixel.token_removed": "Token do Pixel removido",
  "two_factor.enabled": "Verificação em 2 etapas ativada",
  "two_factor.disabled": "Verificação em 2 etapas desativada",
  "two_factor.recovery_codes_regenerated": "Códigos de recuperação renovados",
  "two_factor.reset_by_admin": "Verificação em 2 etapas zerada pela plataforma",
  "waitlist.added": "Entrada na lista de espera",
  "waitlist.removed": "Saída da lista de espera",
  "waitlist.offered": "Encaixe oferecido",
  "backup.config_changed": "Configuração do backup alterada",
  "backup.run_manual": "Backup feito na hora",
  "backup.google_disconnected": "Google Drive do backup desconectado",
  "backup.key_generated": "Chave do backup gerada",
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export type AuditArea = { id: string; label: string; prefixes: readonly string[]; platformOnly?: boolean };

/** Grupos do filtro "O que mudou": cada um cobre um ou mais prefixos de ação (`area.`). */
export const AUDIT_AREAS: readonly AuditArea[] = [
  { id: "agenda", label: "Agenda e agendamentos", prefixes: ["appointment.", "schedule_block.", "waitlist."] },
  { id: "catalogo", label: "Serviços e preços", prefixes: ["service."] },
  { id: "profissionais", label: "Profissionais e horários", prefixes: ["professional.", "working_hours."] },
  { id: "equipe", label: "Equipe", prefixes: ["team."] },
  { id: "empresa", label: "Configurações da empresa", prefixes: ["settings."] },
  { id: "bot", label: "Bot e mensagens", prefixes: ["bot_text.", "bot_flow."] },
  { id: "assinatura", label: "Assinatura e cobrança", prefixes: ["subscription.", "invoice."] },
  { id: "seguranca", label: "Verificação em 2 etapas", prefixes: ["two_factor."] },
  { id: "empresas", label: "Suspensão e teste de empresas", prefixes: ["company."], platformOnly: true },
  { id: "planos", label: "Planos e cupons", prefixes: ["plan.", "coupon."], platformOnly: true },
  { id: "plataforma", label: "Configurações da plataforma", prefixes: ["platform.", "platform_whatsapp.", "pixel."], platformOnly: true },
  { id: "backup", label: "Backup", prefixes: ["backup."], platformOnly: true },
];

export function findArea(id: string | undefined): AuditArea | undefined {
  return AUDIT_AREAS.find((a) => a.id === id);
}

export const ROLE_LABELS: Record<string, string> = {
  OWNER: "Dono",
  STAFF: "Equipe",
  PLATFORM_ADMIN: "Equipe InnoChat",
  SYSTEM: "Sistema",
};

export const FIELD_LABELS: Record<string, string> = {
  name: "Nome",
  durationMin: "Duração (minutos)",
  bufferAfterMin: "Intervalo depois (minutos)",
  priceCents: "Preço",
  annualPriceCents: "Preço anual",
  active: "Ativo",
  sortOrder: "Ordem na lista",
  status: "Situação",
  startsAt: "Horário",
  theme: "Tema",
  documento: "CPF ou CNPJ",
  maxFutureAppointmentsPerContact: "Agendamentos futuros por cliente",
  slotGranularityMin: "Grade de horários (minutos)",
  handoffResumeMinutes: "Bot volta a responder depois de (minutos)",
  notifyClientOnStaffChanges: "Avisar o cliente quando a equipe mexe no agendamento",
  email_de_cobranca: "E-mail de cobrança",
  whatsapp_de_cobranca: "WhatsApp de cobrança",
  nao_receber_whatsapp: "Não receber avisos pelo WhatsApp",
  texto: "Texto",
  papel: "Papel",
  plano: "Plano",
  aplicadoAgora: "Valeu na hora",
  acessoAte: "Acesso até",
  cupom: "Cupom",
  ciclo: "Ciclo",
  servicos: "Serviços atendidos",
  horarios: "Horários",
  motivo: "Motivo",
  abrangencia: "Vale para",
  comissao_padrao: "Comissão padrão",
  maxWhatsappNumbers: "Números de WhatsApp",
  maxProfessionals: "Profissionais",
  description: "Descrição",
  kind: "Tipo",
  value: "Valor",
  validFrom: "Vale a partir de",
  validUntil: "Vale até",
  maxRedemptions: "Limite de usos",
  duration: "Duração do desconto",
  durationCycles: "Ciclos com desconto",
  appliesToCycle: "Vale para o ciclo",
  situacao: "Situação",
  diasExtras: "Dias a mais",
  versao: "Versão",
  evolutionApiUrl: "Endereço da Evolution",
  evolutionApiKey: "Chave da Evolution",
  n8nWebhookBaseUrl: "Endereço dos webhooks do n8n",
  n8nBaseUrl: "Endereço do n8n",
  n8nApiKey: "Chave do n8n",
  smtpHost: "Servidor de e-mail",
  smtpPort: "Porta do e-mail",
  smtpSecure: "Conexão segura do e-mail",
  smtpUser: "Usuário do e-mail",
  smtpPassword: "Senha do e-mail",
  smtpFrom: "Remetente dos e-mails",
  publicBaseUrl: "Endereço público do painel",
  publicKey: "Chave pública",
  accessToken: "Access token",
  webhookSecret: "Segredo do webhook",
  ambiente: "Ambiente",
  enabled: "Ligado",
  clientId: "Client ID",
  clientSecret: "Client Secret",
  pixelId: "ID do Pixel",
  testEventCode: "Código de teste",
  capiToken: "Token da API de Conversões",
  whatsapp: "WhatsApp",
  hourLocal: "Hora do backup",
  retentionDays: "Dias de retenção",
  alertAfterHours: "Alerta após (horas)",
  destination: "Destino",
  driveMode: "Modo do Drive",
  s3Endpoint: "Endereço do bucket",
  s3Bucket: "Bucket",
  s3Region: "Região",
  s3Prefix: "Pasta",
  s3AccessKey: "Chave de acesso do bucket",
  s3SecretKey: "Chave secreta do bucket",
  driveFolderId: "Pasta do Drive",
  driveServiceAccountKey: "Chave da conta de serviço",
  driveOauthClientId: "Client ID do Drive",
  driveOauthClientSecret: "Client Secret do Drive",
  impressaoDigital: "Impressão digital",
  _omitidos: "Campos não mostrados",
};

export function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field]!;
  const [head, ...rest] = field.split(":");
  if (rest.length > 0 && FIELD_LABELS[head!]) return `${FIELD_LABELS[head!]} (${rest.join(":")})`;
  if (head === "comissao_servico" && rest.length > 0) return `Comissão no serviço ${rest.join(":")}`;
  return field;
}

const ENUM_LABELS: Record<string, string> = {
  SCHEDULED: "Agendado",
  COMPLETED: "Concluído",
  NO_SHOW: "Faltou",
  CANCELED: "Cancelado",
  OWNER: "Dono",
  STAFF: "Equipe",
  MONTHLY: "Mensal",
  ANNUAL: "Anual",
  PERCENT: "Porcentagem",
  AMOUNT: "Valor fixo",
  ONCE: "Só a primeira fatura",
  N_CYCLES: "Alguns ciclos",
  FOREVER: "Para sempre",
  ANY: "Qualquer ciclo",
  PRODUCTION: "Produção",
  SANDBOX: "Teste",
  S3: "S3",
  DRIVE: "Google Drive",
  SERVICE_ACCOUNT: "Conta de serviço",
  OAUTH: "Conta Google",
  INDIGO_CLINICO: "Índigo clínico",
  AMBAR_ESTUDIO: "Âmbar estúdio",
  VERDE_SLATE: "Verde slate",
};

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function formatIsoDate(value: string, timezone: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    .format(date)
    .replace(",", " às");
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Valor do de/para em texto de gente: dinheiro em reais, sim/não, datas no fuso informado, enums traduzidos. */
export function formatAuditValue(field: string, value: unknown, timezone = "America/Sao_Paulo"): string {
  if (value === null || value === undefined || value === "") return "vazio";
  if (typeof value === "boolean") return value ? "sim" : "não";
  if (typeof value === "number") {
    if (/cents$/i.test(field)) return BRL.format(value / 100);
    return value.toLocaleString("pt-BR");
  }
  const text = String(value);
  if (text === "[oculto]") return "valor oculto";
  if (ISO_RE.test(text)) return formatIsoDate(text, timezone);
  return ENUM_LABELS[text] ?? text;
}
