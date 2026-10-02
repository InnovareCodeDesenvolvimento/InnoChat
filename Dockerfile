# syntax=docker/dockerfile:1

# InnoChat — imagem única do serviço `innochat-painel` (Next.js standalone,
# porta 3000). Um processo serve painel, API interna (n8n) e webhook do
# Mercado Pago — ver docs/arquitetura.md §1.
#
# Build local/CI:
#   docker build -t innochat-painel -f Dockerfile .
#
# Migrations rodam SOZINHAS no boot do container (CMD abaixo), antes do
# `server.js` abrir a porta — decisão do dono, 2026-09-29. Motivo: o comando
# manual pelo Console roda dentro do container JÁ PUBLICADO, que só conhece as
# migrations da versão anterior; "migrar antes do push" era impossível e todo
# deploy com schema novo ficava com erro 500 até alguém rodar o comando depois.
# Salvaguardas: (1) as migrations da equipe são sempre ADITIVAS (seguras com a
# versão anterior ainda rodando); (2) `prisma migrate deploy` usa advisory lock
# no Postgres — duas réplicas subindo juntas não aplicam a mesma migration duas
# vezes; (3) se a migration falhar, o container não sobe (o `&&` impede o
# server.js) e o healthcheck mantém a versão anterior no ar. O comando manual
# pelo Console continua disponível para diagnóstico.
#
# Prisma + Alpine (musl): build e runtime usam a MESMA imagem base
# (node:${NODE_VERSION}, alpine/musl) — `prisma generate` roda dentro do
# próprio container de build, então o engine "native" já resolve para
# linux-musl corretamente, sem precisar declarar `binaryTargets` explícito
# no schema. Se um dia builder e runtime usarem bases diferentes (ex.: build
# em Debian, runtime em Alpine), isso deixa de ser verdade e
# `prisma/schema.prisma` passa a precisar de
# `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` — sinalizado para
# o Cronos como risco a observar, não como bug atual.

ARG NODE_VERSION=22-alpine

# ---------------------------------------------------------------------------
# Stage: deps — instala TODAS as dependências (incl. dev: typescript, prisma
# cli) uma vez só.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json ./
RUN npm ci

# ---------------------------------------------------------------------------
# Stage: builder — gera o Prisma Client e a build standalone do Next.js.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prisma generate ANTES do next build: o file tracing do Next só embala no
# standalone output o que já existe em node_modules/.prisma no momento do build.
RUN npm run db:generate
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------------------------------------------------------------------------
# Stage: app — runtime do Next.js standalone, porta 3000, usuário não-root.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS app
WORKDIR /app
RUN apk add --no-cache openssl dumb-init
# Cliente do PostgreSQL (`pg_dump` e `pg_restore`) para o backup automático (Admin > Backup,
# docs/runbook.md). REGRA: o cliente tem de ser da MESMA versão do servidor ou mais novo; cliente
# mais velho que o banco se RECUSA a copiar. O Easypanel cria o Postgres 17 ou 18 (docs/deploy-easypanel.md)
# e o CI testa com o 18, então pedimos o 18 e, se a Alpine desta imagem ainda não o tiver, caímos no 17.
# Se cair no 17 e o banco for 18, a primeira cópia falha com a mensagem exata do que atualizar (a tela
# Backup mostra o erro e o sistema manda e-mail): suba a versão da imagem node ou do pacote aqui.
RUN (apk add --no-cache postgresql18-client || apk add --no-cache postgresql17-client) \
  && pg_dump --version
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# next build com output:'standalone' já produz um node_modules mínimo com o
# tracing do Prisma Client incluso — não copiamos node_modules completo aqui.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Prisma CLI + migrations no runtime, só para `npx prisma migrate deploy` rodar pelo Console do
# Easypanel (docs/deploy-easypanel.md) — o node_modules do standalone acima é tracing de
# runtime do Next e NÃO inclui devDependencies (a CLI do Prisma é uma delas). `prisma/migrations`
# + `schema.prisma` também precisam estar no runtime — não fazem parte do output standalone (só
# código de aplicação).
#
# A instalação roda numa pasta ISOLADA (`npm install --prefix /tmp/prisma-cli`), não direto em
# /app: rodar `npm install <pkg>` com o package.json completo do projeto presente em /app, mas
# SEM package-lock.json nesta imagem, arrisca o npm tentar reconciliar TODAS as dependências
# declaradas contra o node_modules já podado do standalone — poderia reinstalar/alterar versões
# de pacotes que o Next rastreou com cuidado para o build (next, react, etc.). Instalando isolado
# e só copiando o resultado (`cp -R`) para dentro de /app/node_modules, a CLI do Prisma entra sem
# tocar em mais nada. `package.json` fica em /app só para `npm run db:migrate` funcionar como
# atalho de `npx prisma migrate deploy` pelo Console (mesmo script do package.json).
#
# NÃO VALIDADO por um `docker build` real nesta sessão (sem Docker disponível na máquina) — só
# raciocinado a partir do comportamento documentado do npm/Prisma. Testar no primeiro deploy real
# e, se `npx prisma migrate deploy` falhar no Console por binário ausente, investigar a partir daqui.
COPY --from=builder /app/prisma ./prisma
COPY package.json ./package.json
RUN PRISMA_VERSION=$(node -p "require('./package.json').devDependencies.prisma.replace(/^[^0-9]*/, '')") \
  && npm install --prefix /tmp/prisma-cli --no-save "prisma@${PRISMA_VERSION}" \
  && cp -R /tmp/prisma-cli/node_modules/. /app/node_modules/ \
  && rm -rf /tmp/prisma-cli \
  && chown -R node:node /app/node_modules /app/prisma /app/package.json

USER node
EXPOSE 3000

# GET /api/health faz um SELECT 1 leve no Postgres (src/app/api/health/route.ts) — prova que o
# processo está de pé E consegue falar com o banco, não só que a porta responde. Esta instrução
# HEALTHCHECK é o container reportando a própria saúde ao Docker/Swarm (o Easypanel roda sobre
# Docker Swarm); confirmar na aba de "Health Check" do serviço no Easypanel se há também um campo
# de UI para apontar `/api/health` explicitamente (docs/deploy-easypanel.md) — não assumir que o
# painel usa isto automaticamente sem checar a interface real (lição registrada: interfaces reais
# do Easypanel já divergiram do que parecia óbvio de fora).
# `wget` vem do busybox da imagem alpine (sem instalar nada extra); start-period dá tempo do
# Next.js standalone terminar de subir antes da primeira checagem contar como falha.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget --quiet --spider --tries=1 "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

# server.js é o entrypoint gerado pelo Next standalone. Sem `npm run start`:
# evita o processo intermediário do npm e deixa o Node receber SIGTERM direto
# do orquestrador (Easypanel) para desligar de forma graciosa.
ENTRYPOINT ["dumb-init", "--"]
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node server.js"]
