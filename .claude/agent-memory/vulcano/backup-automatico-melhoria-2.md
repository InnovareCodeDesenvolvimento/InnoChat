---
name: backup-automatico-melhoria-2
description: Como o backup do InnoChat foi portado do Parque das Feiras (módulo, agendador, Dockerfile, CI) e o que ficou sem prova real
metadata:
  type: project
---

Backup automático (Melhoria 2, 2026-10-02) vive em `src/modules/backup/` (drive, drive-oauth, policy, service, actions), tela `/admin/backup`, timer em `src/instrumentation.ts` (a cada 10 min) e rota `POST /api/internal/v1/backup/tick` como segunda via.

**Why:** a régua de cobrança agenda por cron externo (n8n chamando rota interna), mas o pedido dizia "agendador no processo"; fiz os dois (timer + rota). A trava `runningSince` (UPDATE condicional) e a janela de 20 h entre tentativas tornam seguro chamar das duas formas.

**How to apply:**
- Postgres de produção é "17 ou 18" (Easypanel), CI usa 18. Dockerfile instala `postgresql18-client` com queda para `postgresql17-client`. NÃO foi testado com `docker build` (sem Docker na máquina). Se a imagem node:22-alpine ainda for Alpine 3.22, cai no 17 e a cópia falha com mensagem clara se o banco for 18.
- Provas reais: ciclo seed/dump/DROP SCHEMA/restore/conferir rodou local com PG 18.1 (`C:/Program Files/PostgreSQL/18/bin`), mas o job do CI ainda não rodou.
- Armadilha de ambiente: heredoc com aspas simples/apóstrofo dentro do Bash tool quebra ("unexpected EOF"); escrever arquivos com o Write tool.
- Armadilha de Python em heredoc: string terminando em `\` quebra; usar Edit tool.
- `next build` falha por type error em arquivos de outros agentes trabalhando no mesmo tree (ex.: pricing.test.ts); compilação do meu código passou.
