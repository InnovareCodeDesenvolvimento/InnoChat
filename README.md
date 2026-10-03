# InnoChat

Chatbot de agendamento via WhatsApp para clínicas, salões e negócios de serviços com horário marcado. Painel web multiempresa com assinatura mensal em Pix.

- **Clientes finais** conversam com um bot numerado no WhatsApp para agendar, consultar agendamentos, cancelar ou remarcar.
- **Dona da empresa** gerencia serviços, profissionais, expediente, clientes e pagamentos num painel web.
- **Plataforma** orquestra tudo: identidade, cobrança, instâncias do WhatsApp via Evolution, workflows de automação no n8n.

Estado: **em produção** (v1.7.4). Funcional localmente e via Easypanel.

---

## Últimas novidades (v1.7.0–v1.7.4)

- **Plano anual com desconto** e **cupons** de promoção.
- **Lista de espera:** bot oferece fila quando o dia está cheio; primeiro da lista recebe encaixe por WhatsApp.
- **Relatórios** de faturamento, serviço, profissional e comissões (com download CSV).
- **Monitor de erros:** erros do servidor e navegador registrados e agrupados; Admin consegue resolver/ignorar.
- **Backup automático e cifrado** para S3 ou Google Drive, com chave própria e restauração via script.
- **Verificação em 2 etapas** (TOTP + códigos de recuperação), obrigatória para Admin da plataforma.
- **Auditoria de 5 anos:** histórico de quem mudou o quê, quando e por quê.
- **Pixel do Meta + CAPI** e consentimento LGPD de cookies em páginas públicas.
- **WhatsApp de cobrança:** resposta automática a cada 10 minutos (máx. 6/dia), com diagnóstico no Admin.
- **Configurações em abas:** todas as config. da plataforma centralizadas em `/admin/configuracoes/<aba>`.
- **Versão do fluxo do bot:** histórico e trava (fluxo mudado sem subir versão avisa no CI).
- **Recarga automática** após publicação (cliente que estava com página aberta vê a versão nova).

---

## Stack

| Camada | Tecnologia |
|--------|-----------|
| **Frontend** | Next.js 16 (App Router) + React 19 + TypeScript |
| **Styling** | Tailwind CSS 4 + Radix UI + shadcn |
| **Backend** | Next.js API routes + Server Actions |
| **Database** | PostgreSQL 17+ + Prisma ORM |
| **Auth** | Auth.js v5 (credenciais, JWT sessions) |
| **Automação** | n8n (workflows do bot e cron) |
| **Chat** | Evolution API (Baileys) + WhatsApp nativo |
| **Pagamento** | Mercado Pago (Pix pontual) |
| **E-mail** | SMTP próprio (via nodemailer) |
| **Testes** | Vitest (unit + integração), Playwright (E2E) |
| **Deploy** | Docker + Easypanel |

---

## Estrutura de pastas

```
src/
├─ app/                          Rotas e layouts Next.js
│  ├─ (public)/                  Páginas públicas (cadastro, login, termos)
│  ├─ (auth)/                    Fluxos de autenticação
│  ├─ (app)/[tenantSlug]/        Painel da empresa (Início, Agenda, Agendamentos, etc.)
│  ├─ (platform)/admin/          Painel do admin da plataforma (Empresas, Cobrança, Configurações)
│  ├─ api/internal/v1/           API interna para n8n (claim, sessão, agenda, agendamento)
│  ├─ api/webhooks/              Webhooks (Mercado Pago)
│  ├─ api/whatsapp/              Conexão e estado das instâncias
│  ├─ api/agenda/                Disponibilidade (para o navegador)
│  └─ api/billing/               Consulta de faturas
├─ core/                         Funções puras (agenda, cobrança, textos)
├─ modules/                      Serviços e integrações (agenda, bot-api, whatsapp [Evolution], tenant, platform [n8n], billing [Mercado Pago], contacts, signup, maintenance)
└─ lib/                          Utilitários (db, auth, email, errors, logger, legal)

n8n/                             Workflows exportados (innochat-bot.json, innochat-erros.json, innochat-cron.json)
fixtures/evolution/              Payloads de exemplo da Evolution (da doc pública; ainda não capturados do servidor real)
tests/                           Testes
├─ integration/                  Integração contra Postgres real (banco innochat_test)
└─ e2e/                          Testes Playwright
prisma/                          Schema e migrations
docs/                            Documentação (arquitetura, contratos, deploy)
```

---

## Como rodar localmente

### Pré-requisitos

- **Node.js** 20+ com npm
- **PostgreSQL** 17+ rodando em `localhost:5432`

### 1. Clonar e instalar

```bash
git clone https://github.com/InnovareCode/InnoChat.git
cd InnoChat
npm ci
```

### 2. Banco de dados

Crie dois bancos localmente:

```bash
# Desenvolvimento
createdb innochat

# Testes (integração)
createdb innochat_test
```

### 3. Variáveis de ambiente

Copie o exemplo e ajuste:

```bash
cp .env.example .env
```

Edite `.env`:

```env
# Dev local
DATABASE_URL=postgresql://postgres:SENHA_LOCAL@localhost:5432/innochat

# Gere uma chave aleatória
AUTH_SECRET=<output de: openssl rand -base64 32>

# Testes de integração (opcional, deixe comentado se não vai rodar testes)
# TEST_DATABASE_URL=postgresql://postgres:SENHA_LOCAL@localhost:5432/innochat_test
```

### 4. Schema e seed (opcional)

Aplicar as migrations:

```bash
npm run db:migrate
```

Criar um usuário de dev (e-mail: `dev@innochat.local`, senha: `innochat-dev-2026`):

```bash
npm run db:seed
```

### 5. Iniciar o servidor

```bash
npm run dev
```

Abra http://localhost:3000

- **Painel público:** cadastro, login, esqueci senha
- **Painel da empresa:** `/[tenantSlug]/inicio` (após login e onboarding)
- **Admin da plataforma:** `/admin/` (acesso só para `isPlatformAdmin`)
- **Instalação do primeiro admin:** `/instalacao` (só aparece se nenhum admin existir; código no log)

---

## Scripts npm

| Comando | Descrição |
|---------|-----------|
| `npm run dev` | Inicia o servidor Next.js em modo desenvolvimento (hot reload) |
| `npm run build` | Build de produção |
| `npm start` | Inicia o servidor de produção (requer `build` antes) |
| `npm run lint` | Executa eslint |
| `npm run typecheck` | TypeScript strict (sem emit) |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:integration` | Testes de integração contra Postgres real (`innochat_test`) |
| `npm run test:e2e` | Testes E2E com Playwright |
| `npm run db:migrate` | Aplica migrations do Prisma |
| `npm run db:generate` | Regenera Prisma Client |
| `npm run db:seed` | Executa seed (cria dev@innochat.local) |
| `npm run db:studio` | Abre Prisma Studio (UI do banco) |
| `npm run generate:openapi` | Gera OpenAPI da API interna (automático em CI) |

---

## Testes

### Unit (Vitest)

Testa funções puras (agenda, cobrança, normalização de payload, validação).

```bash
npm test
```

### Integração (Vitest + Postgres real)

Testa endpoints da API interna (`/api/internal/v1/*`) contra um banco real (`innochat_test`). Cobre:
- Autenticação (sem Bearer → 401; token inválido → 401)
- Isolamento entre tenants (ID de outro tenant → 404)
- Casos de `POST /messages/claim` (dedupe, trava, expiração, remetente)
- Concorrência (20 requisições simultâneas no mesmo slot → exatamente 1 sucesso, 19 conflitos)
- Idempotência (mesma chave → resultado idêntico)

```bash
npm run test:integration
```

### E2E (Playwright)

Testa o painel via navegador:
- Cadastro e verificação de e-mail
- Login
- Onboarding
- QR do WhatsApp (simulado)
- Agenda
- Pagamento (Mercado Pago em sandbox)

```bash
npm run test:e2e
```

Config separada em `playwright.instalacao.config.ts` para testes de instalação do primeiro admin.

---

## Workflows n8n

O InnoChat depende de três workflows no n8n:

| Arquivo | Workflow | O que faz | Estado |
|---------|----------|----------|--------|
| `n8n/innochat-bot.json` | `innochat-bot` | Recebe mensagem → interpreta menu → chama API interna → envia resposta | **inativo** (ativa na publicação) |
| `n8n/innochat-erros.json` | `innochat-erros` | Dispara se `innochat-bot` falha; libera a trava da sessão | **inativo** |
| `n8n/innochat-cron.json` | `innochat-cron` | De hora em hora: `POST /billing/tick`. Diariamente 03:15: `POST /maintenance/tick` (LGPD) | **inativo** |

Ver `n8n/README.md` para:
- Como importar e configurar credenciais
- Placeholders a preencher (URLs da Evolution, n8n, painel)
- Estrutura de cada nó
- Testes em sandbox

---

## Testes e bateria de roteiros

### Bateria de roteiros do bot (ainda não existe)

A bateria de roteiros de conversa ponta a ponta contra uma instância `sandbox` (`docs/arquitetura.md` §8)
**ainda não foi implementada**: depende do painel publicado e do n8n ativo. Hoje, o fluxo do bot é coberto
por testes de integração da API interna (`tests/integration/bot-api*.integration.test.ts`) e por simulação
dos nós do n8n (`n8n/README.md`).

### Teste de contrato da API interna

`npm run test:integration` também valida o contrato contra `docs/api-interna.openapi.json`.

### Ponta a ponta real

Requer um número de WhatsApp conectado à plataforma:
1. Ligar o bot (`/admin/configuracoes/automacao` → "Ativar bot")
2. Enviar "oi" pelo número conectado
3. Seguir fluxo completo (agendar, cancelar, remarcar)
4. Confirmar que Pix foi gerado e e-mail chegou

---

## Docs

- **`docs/arquitetura.md`** — decisões, stack, modelo de dados, contratos, plano faseado, riscos
- **`docs/contratos.md`** — assinaturas de Server Actions e rotas (API do painel, autenticação, admin)
- **`docs/deploy-easypanel.md`** — passo a passo para deploy em produção (Postgres, App, domínio, migration, admin)
- **`docs/manual-do-cliente.md`** — instruções para dona da empresa (criar conta, agendar via bot, gerir painel)
- **`docs/runbook.md`** — operação para dono da plataforma (saúde, incidentes, backup, rollback)

---

## Segurança e LGPD

- **Isolamento entre empresas:** `forTenant()` + lint + validação de tenant na API interna
- **Segredos no banco:** Evolution, n8n, Mercado Pago, SMTP — guardados mascarados em `PlatformSettings`
- **Segredo interno do n8n:** gerado uma vez, guardado como hash SHA-256
- **Webhook do MP:** assinatura verificada + reconsulta do pagamento
- **Termos e privacidade:** versão gravada no cadastro e aceite revalidado; anonimização 90 dias após `CANCELED`
- **Nenhum conteúdo de mensagem em log:** `InboundEvent` sem texto, execuções do n8n sem dados de sucesso
- **Sem histórico de conversa na v1** (decisão do dono)

---

## Troubleshooting

**"Erro na migration"** → Rode `npx prisma migrate resolve` se uma migration falhar; não force de novo.

**"Pagina em branco no localhost"** → Confira se o `AUTH_SECRET` foi gerado e salvo em `.env`.

**"Bot não responde"** → Confira: assinatura do tenant está `ACTIVE` ou `TRIALING`? Workflow `innochat-bot` está ativo no n8n? URLs da Evolution e n8n foram configuradas em `/admin/configuracoes/whatsapp` (Evolution) e `/admin/configuracoes/automacao` (n8n)?

**"Testes E2E falhando"** → Rode sem headless para ver a tela: `npx playwright test --headed`.

---

## Contribuindo

1. Crie uma branch a partir de `main`
2. Faça suas mudanças + testes (`npm test && npm run test:integration`)
3. Commit com mensagem descritiva
4. Push e abra um PR
5. Aguarde aprovação da squad (Órion para segurança, Íris para QA)

---

## Licença

Propriedade de InnovareCode. Uso interno.

---

## Contato

Dúvidas sobre o projeto? Entre em contato com a squad via GitHub Issues ou Discord.
