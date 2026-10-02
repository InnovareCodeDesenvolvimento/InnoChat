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

## Cifra do backup (Melhoria 2b, 2026-10-02, depois do commit 0eacac8)

Decisão do dono: tudo que sai do servidor sai cifrado e a restauração TEM que funcionar. Código em `src/modules/backup/backup-crypto.ts` (AES-256-GCM em fluxo, `.dump.enc`, cabeçalho "INNOBKP"+versão+impressão digital+IV, tag no fim, cabeçalho como AAD). `scripts/decrypt-backup.mjs` reimplementa o MESMO formato sem depender do projeto (roda só com Node, também cifra com `--cifrar`); `backup-crypto.test.ts` testa os dois em ambos os sentidos, então mudar um sem o outro quebra o teste.

**Why:** a chave própria (32 bytes, independente do AUTH_SECRET) é mostrada ao dono uma única vez; o sistema guarda uma cópia cifrada com `crypto.ts` só para o agendador cifrar de madrugada. Se o AUTH_SECRET mudar, o sistema perde a chave (erro `KEY`) e o dono usa a que guardou.

**How to apply:**
- Backup com destino e sem chave FALHA (código KEY, aparece no histórico e manda e-mail no agendado); ligar o automático sem chave é recusado (`BACKUP_KEY_MISSING`). Teste manual sem destino não exige chave. Instalação que já tinha automático ligado vai falhar até gerar a chave, de propósito.
- `BackupRun.trigger = 'VERIFY'` é a conferência (não é backup, não mexe em `lastSuccessAt`). O tick confere 1x por semana (tentativa que falhou também conta, para não martelar a cada 10 min) e só com automático ligado, destino, chave e ao menos uma cópia enviada.
- `RunBackupDeps.send` e `fetchLatest` são seams só de teste (a integração não alcança S3/Drive reais). O envio real ao S3 e o download real (S3 `GetObject`, Drive `alt=media`) NÃO foram provados contra serviço de verdade.
- Arquivo `"use server"` só pode exportar funções async: constante compartilhada (`REPLACE_KEY_CONFIRMATION`) mora em `policy.ts`.
- Heredoc do Bash tool com apóstrofo (mesmo em 'PYEOF') quebra; para scripts Python/TS com texto em português, usar o Write tool e rodar o arquivo.
- Prova local: ciclo completo cifrado com PG 18.1 em banco descartável (backup-db.sh com BACKUP_KEY_FILE, DROP SCHEMA, chave errada/adulterado/sem --chave param antes de tocar no banco, restore com --chave, smoke conferir). O job de CI reescrito NÃO rodou ainda.
