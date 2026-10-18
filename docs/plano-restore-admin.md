# Plano: Restore de Backup pelo Admin

Autor original da arquitetura: Nova.  
Documentação técnica e consolidação: Alexandria.  
Status da funcionalidade: em andamento (Onda 1 entregue e testada, Onda 2 com probe e lock no código, Onda 3 planejada, Onda 4 em backlog).  
Referência técnica primária: `.claude/agent-memory/nova/restore-pelo-admin-arquitetura.md`.

---

## 1. Contexto

Até a versão 1.13 do InnoChat, toda a rotina de backup contava com automação completa no painel em **Admin → Backup** (`/admin/backup`): agendamento diário, envio fora do servidor (Google Drive ou bucket S3 compatível), criptografia AES-256-GCM em fluxo com arquivo `.dump.enc` e verificação semanal automática de integridade.

No entanto, a restauração ainda dependia exclusivamente de linha de comando manual:
1. O administrador precisava acessar o console do Easypanel ou um terminal com cliente PostgreSQL 18.
2. Localizar o arquivo `.dump.enc` correspondente no Google Drive ou bucket S3.
3. Obter o arquivo de chave `chave-backup-innochat-*.txt` guardado fora do servidor.
4. Executar `./scripts/restore-db.sh` informando manualmente a string de conexão e os parâmetros de confirmação.

No incidente de 2026-10-17, durante a migração de servidor no Easypanel, a recuperação do banco demandou tempo operacional desnecessário para localizar arquivos, baixar dumps e executar comandos no terminal do contêiner.

O objetivo do **Restore pelo Admin** é espelhar no painel a gestão dos backups já existentes, permitindo que a equipe de administração da plataforma consulte cópias disponíveis na nuvem, faça o download direto e execute a restauração com salvaguardas rígidas de segurança diretamente pela interface web.

---

## 2. Decisões arquiteturais

### 2.1 Uso híbrido da chave de criptografia
O InnoChat armazena no banco de dados o campo `encryptionKeyEnc` (cifrado com o `AUTH_SECRET` da aplicação) para permitir que as rotinas automáticas de madrugada gerem os arquivos criptografados.

Para o processo de inspeção e restauração, o administrador dispõe de dois modos:
1. **Chave salva no sistema (`SYSTEM`)**: utilizada quando o banco atual ainda possui a chave ativa e a impressão digital (fingerprint) do backup corresponde à impressão da chave do sistema.
2. **Chave informada manualmente (`CUSTOM`)**: o administrador cola o texto hexadecimal de 64 caracteres ou envia o arquivo `chave-backup-innochat-*.txt`. Essa chave é processada exclusivamente em memória durante a requisição no Server Action e **nunca é persistida nem registrada em logs de auditoria**. Nos registros de log e auditoria aparece apenas a impressão digital de 8 caracteres.

### 2.2 Estratégia em ondas de entrega
Para manter a segurança e a estabilidade da plataforma, a funcionalidade foi dividida em 4 ondas sucessivas:

| Onda | Escopo | Situação |
|---|---|---|
| **Onda 1** | Listagem paginada e download em fluxo de backups remotos | Concluída |
| **Onda 2** | Teste de integridade (Probe) e decifração em memória isolada | Em andamento |
| **Onda 3** | Execução de restauração com 2FA, pré-backup e trava de concorrência | Planejada |
| **Onda 4** | Restauração de teste em schema paralelo descartável | Backlog |

---

## 3. Onda 1: Listar e baixar backups remotos (Concluída)

A primeira etapa disponibiliza a visualização do acervo de backups remotos e o download dos arquivos diretamente para o computador do administrador.

### O que foi entregue
- **Leitura do armazenamento remoto**: suporte a Google Drive (pasta configurada via OAuth ou conta de serviço) e buckets compatíveis com S3 (AWS, Cloudflare R2, Backblaze).
- **Paginação e ordenação**: paginação numerada (10, 25, 50 ou 100 itens por página) seguindo o padrão visual do painel, com ordenação decrescente por data de criação.
- **Identificador unificado de arquivo (`ref`)**:
  - Google Drive: `drive:<fileId>/<nome-do-arquivo>`
  - S3: `s3:<caminho-do-objeto>`
- **Download em fluxo (stream)**: endpoint HTTP GET que faz o repasse contínuo dos bytes sem carregar o arquivo inteiro na memória do contêiner Node.js.
- **Auditoria de ações**: registro de eventos de consulta e download no histórico de auditoria da plataforma.

### Componentes e arquivos
- `src/modules/backup/restore-types.ts`: definição de tipos `RemoteBackupItem`, `ListRemoteBackupsResult` e `RemoteBackupSource`.
- `src/modules/backup/restore-service.ts`: funções `parseBackupRef`, `listRemoteBackups` e `streamRemoteBackup`.
- `src/modules/backup/restore-actions.ts`: Server Action `listRemoteBackupsAction`.
- `src/app/api/admin/backup/download/route.ts`: rota de download autenticada para administradores com 2FA ativa.
- `src/components/admin/backup/remote-backups-list.tsx`: tabela com data formatada no fuso de Brasília, tamanho em bytes legíveis, identificação de origem e botão de download.
- `src/app/(platform)/admin/backup/page.tsx` e `backup-client.tsx`: integração da tabela à aba de Backup.

---

## 4. Onda 2: Teste de integridade e decifração em memória (Em andamento)

A segunda etapa permite testar a validade do arquivo antes de qualquer tentativa real de restauração, comprovando se o arquivo está íntegro e se a chave fornecida consegue abri-lo.

### O que compreende
1. **Ambiente temporário isolado**: criação de diretório em `/tmp` com permissão estrita `0700` e arquivo temporário com permissão `0600`.
2. **Download em fluxo temporário**: transferência do arquivo remoto para o disco temporário.
3. **Conferência de cabeçalho**: leitura do marcador inicial `INNOBKP` v1 e extração da impressão digital embutida no arquivo sem decifrar todo o conteúdo.
4. **Decifração autenticada**: aplicação do algoritmo AES-256-GCM validando a integridade da chave e a tag de autenticação. Detecta se a chave está incorreta ou se o arquivo sofreu alterações.
5. **Inspeção com `pg_restore --list`**: leitura do catálogo interno do dump sem gravar dados no banco de dados, contando quantas tabelas possuem registros.
6. **Descarte obrigatório**: remoção garantida de todo o diretório temporário no bloco `finally`, independentemente de sucesso ou falha.
7. **Modelo de trava (`RestoreLock`)**: criação da tabela singleton `restore_locks` no banco de dados para gerenciar o estado do restore e impedir execuções simultâneas.

### Arquivos e status da Onda 2
- `src/modules/backup/restore-types.ts`: tipos `ProbeBackupInput`, `ProbeKeyMode` e `ProbeBackupResult`.
- `src/modules/backup/restore-service.ts`: implementação de `probeBackup` e tratamento dos erros de criptografia.
- `src/modules/backup/restore-actions.ts`: Server Action `probeBackupInspectAction`.
- `src/modules/backup/restore-lock.ts`: controle atômico do registro singleton via Prisma (`acquireRestoreLock`, `releaseRestoreLock`).
- `prisma/migrations/20261018100000_restore_lock/migration.sql`: migration do PostgreSQL criando a tabela `restore_locks` e o enum `RestoreLockStatus`.
- `src/components/help/help-content.ts`: tópicos explicativos `backup.copiasRemotas` e `backup.probeIntegridade`.

---

## 5. Onda 3: Execução de restauração pelo Admin (Planejada)

A terceira etapa é a execução definitiva da restauração do banco de dados através do painel, substituindo os dados vigentes pelo conteúdo do backup selecionado.

### 5.1 Pré-requisitos de segurança
Para iniciar a restauração, o sistema exigirá do administrador:
1. **Autenticação em duas etapas válida**: confirmação recente via código TOTP ou senha do administrador da plataforma.
2. **Motivo do procedimento**: campo de texto obrigatório com no mínimo 15 caracteres explicando a razão da restauração para registro histórico.
3. **Confirmação forte digitada**: digitação exata da frase de segurança em caixa alta: `RESTAURAR O BANCO AGORA`.
4. **Verificação de integridade aprovada**: o arquivo precisa ter passado pelo teste da Onda 2 com sucesso.

### 5.2 Fluxo operacional e salvaguardas
```
[Início pelo Admin]
       │
       ▼
[1. Validações e 2FA] ──(Falha)──► [Rejeita a operação]
       │
       ▼
[2. Aquisição do RestoreLock] ──(Ocupado)──► [Rejeita: processo em andamento]
       │
       ▼
[3. Pré-backup de segurança automático (safety dump)]
       │
       ▼
[4. Download e decifração do dump selecionado]
       │
       ▼
[5. Execução do pg_restore no banco de produção]
       │
       ▼
[6. Execução de prisma migrate deploy para alinhar schema]
       │
       ▼
[7. Liberação do RestoreLock e Registro em AuditLog]
       │
       ▼
[Conclusão e notificação aos administradores]
```

### 5.3 Backup de emergência automático (Safety Pre-Restore Dump)
Antes de executar qualquer comando que modifique as tabelas, o servidor executa um `pg_dump` completo do estado atual da base de dados e salva o caminho no registro `safetyDumpPath` da tabela `restore_locks`. Se a restauração for interrompida ou apresentar incompatibilidade grave, o estado anterior poderá ser recuperado imediatamente.

### 5.4 Bloqueio de concorrência (`restore_locks`)
A tabela `restore_locks` funciona como um semáforo distribuído. Ao iniciar a operação:
- O status muda de `IDLE` para `RESTORING`.
- Os campos `lockedBy` (identificador do administrador) e `lockedAt` (data e hora de início) são preenchidos.
- Nenhuma outra rotina de restauração ou job concorrente de backup pode iniciar enquanto o status não retornar para `IDLE`.

---

## 6. Contrato de API e tipos

### Tipos de dados (`src/modules/backup/restore-types.ts`)

```typescript
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
```

### Server Actions expostas (`src/modules/backup/restore-actions.ts`)

1. **`listRemoteBackupsAction(input?: unknown)`**
   - **Permissão**: exige `requirePlatformAdmin()` com sessão ativa.
   - **Parâmetros**: `{ page?: number, pageSize?: 10 | 25 | 50 | 100 }`.
   - **Retorno**: `Result<ListRemoteBackupsResult>`.
   - **Ação de auditoria**: `backup.remote_listed`.

2. **`probeBackupInspectAction(input: unknown)`**
   - **Permissão**: exige `requirePlatformAdmin()` com sessão ativa.
   - **Parâmetros**: `{ ref: string, keyMode: "SYSTEM" | "CUSTOM", customKeyHex?: string | null }`.
   - **Retorno**: `Result<ProbeBackupResult>`.
   - **Ação de auditoria**: `backup.remote_probed`.
   - **Segurança de dados**: a chave customizada é descartada da memória logo após o uso e nunca é escrita nos registros de auditoria.

### Rota de download (`src/app/api/admin/backup/download/route.ts`)

- **Método**: `GET /api/admin/backup/download?ref=<referencia>`
- **Permissão**: exige `requirePlatformAdmin()` com 2FA ativa.
- **Cabeçalhos de resposta**: `Content-Disposition: attachment; filename="..."`, `Content-Type: application/octet-stream`, `Cache-Control: no-store`.
- **Ação de auditoria**: `backup.remote_downloaded`.

---

## 7. Salvaguardas de segurança

1. **Restrição de perfil de acesso**: apenas usuários com papel `PLATFORM_ADMIN` e com segundo fator de autenticação (2FA) configurado podem acessar as telas e acionar os endpoints de download, teste ou restauração.
2. **Proteção contra vazamento de chave**: chaves coladas manualmente residem apenas em buffers efêmeros da requisição Node.js. Variáveis de log recebem apenas a impressão digital (`keyFingerprint`), que consiste nos primeiros 8 caracteres hexadecimais do hash da chave.
3. **Validação criptográfica estrita**: backups gerados pelo InnoChat usam AES-256-GCM. Arquivos adulterados, incompletos ou abertos com chave divergente são rejeitados antes de alcançar qualquer utilitário de banco de dados.
4. **Trilha de auditoria detalhada**: todas as ações de listagem, download, teste de integridade e restauração são gravadas na tabela `audit_logs` associadas ao administrador responsável, sob o grupo de ações `backup.*`.
5. **Prevenção de sobrescrita acidental**: exigência de digitação manual da confirmação `RESTAURAR O BANCO AGORA` e justificativa textual com pelo menos 15 caracteres.
6. **Proteção contra caminhos maliciosos (Path Traversal)**: o parser de referências `parseBackupRef` valida os identificadores com expressões regulares e bloqueia caracteres de navegação em diretórios como `..`, `/` ou `\`.

---

## 8. Runbook de uso pelo administrador

### 8.1 Como baixar um backup para arquivamento
1. Acesse o painel com perfil de administrador da plataforma.
2. No menu lateral, navegue até **Admin → Backup** (`/admin/backup`).
3. Localize o cartão **Cópias no Armazenamento Remoto**.
4. Encontre o arquivo desejado pela data e horário de criação.
5. Clique no botão de download ao lado do item. O arquivo `.dump.enc` será baixado diretamente pelo navegador.
6. Certifique-se de manter guardado o arquivo de chave correspondente à impressão digital exibida na tela.

### 8.2 Como testar a integridade de uma cópia (Probe)
1. No cartão de cópias remotas, selecione o arquivo que deseja inspecionar e acione o teste de integridade.
2. Defina o método da chave:
   - Escolha **Usar chave atual do sistema** se o backup foi gerado recentemente com as configurações vigentes.
   - Escolha **Digitar chave manualmente** se a cópia for antiga ou de outra instalação, colando o conteúdo do arquivo `chave-backup-innochat-*.txt`.
3. Inicie o teste. O sistema baixará o arquivo para uma área de memória segura, validará o fluxo e exibirá o total de tabelas com dados encontrados.
4. Ao final, a área temporária será esvaziada e nenhum dado do banco em produção sofrerá alteração.

### 8.3 Como restaurar o banco pelo painel (Quando a Onda 3 for ativada)
1. Na lista de cópias remotas, execute primeiro o teste de integridade do arquivo desejado.
2. Com a integridade validada, clique na opção de restauração.
3. Informe o código de verificação em duas etapas (2FA).
4. Preencha o motivo da operação (exemplo: `Recuperação de agendamentos após falha de migração`).
5. Digite exatamente a frase de confirmação: `RESTAURAR O BANCO AGORA`.
6. O sistema gerará o backup de emergência da base atual, aplicará o dump selecionado e executará as migrações do Prisma para alinhar a estrutura das tabelas.
7. Ao término, os administradores receberão a confirmação na tela e o registro constará na auditoria da plataforma.

---

## 9. Pendências e passos futuros

1. **Interface visual da Onda 2 (Lyra)**: inclusão do modal ou painel de teste de integridade na tela de Backup do Admin, permitindo ao usuário escolher a chave e ver o resultado formatado.
2. **Implementação da Onda 3 (Vega e Cronos)**:
   - Server Action de restauração definitiva com integração ao `acquireRestoreLock`.
   - Rotina automatizada do pré-backup de segurança (`safety dump`).
   - Execução monitorada do `pg_restore` e disparo de `npx prisma migrate deploy` pós-restauração.
3. **Onda 4 no backlog da arquitetura**: desenvolvimento de restauração em schema paralelo de teste (exemplo: schema temporário `restore_preview`), permitindo ao administrador navegar e comparar dados antes de substituir o banco de produção.

---

## 10. Arquivos do projeto por onda

| Arquivo | Descrição | Status |
|---|---|---|
| `src/modules/backup/restore-types.ts` | Tipos TypeScript de listagem, download e teste de integridade | Concluído |
| `src/modules/backup/restore-service.ts` | Serviços de listagem, download em stream e teste (probe) | Concluído |
| `src/modules/backup/restore-actions.ts` | Server Actions de listagem e inspeção com auditoria | Concluído |
| `src/app/api/admin/backup/download/route.ts` | Rota autenticada de download de backups remotos | Concluído |
| `src/components/admin/backup/remote-backups-list.tsx` | Tabela de exibição de cópias remotas com paginação | Concluído |
| `src/components/help/help-content.ts` | Textos de ajuda contextual ⓘ para cópias remotas e probe | Concluído |
| `src/modules/audit/labels.ts` | Rótulos de auditoria para ações de backup remoto | Concluído |
| `prisma/migrations/20261018100000_restore_lock` | Migration da tabela `restore_locks` e enum `RestoreLockStatus` | Concluído |
| `src/modules/backup/restore-lock.ts` | Funções de controle atômico do singleton de lock no Prisma | Concluído |
| `src/components/admin/backup/restore-probe-modal.tsx` | Componente de interface para o teste de integridade | Em andamento |
| `src/modules/backup/restore-execution.ts` | Execução completa da restauração (Onda 3) | Pendente |
