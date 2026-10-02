#!/usr/bin/env sh
#
# Backup do banco do InnoChat por linha de comando. O backup agendado roda dentro do sistema
# (Admin > Backup); este script serve ao CI, a uma cópia manual antes de uma operação arriscada e a
# quem prefere ter o arquivo local.
#
# Gera um dump no formato CUSTOM do PostgreSQL (-Fc): já vem comprimido e permite restaurar uma
# tabela isolada, coisa que um .sql puro não permite.
#
# Uso:
#   DATABASE_URL=postgresql://... ./scripts/backup-db.sh [destino]
#
# O destino padrão é ./backups (ignorado pelo Git: o dump tem dados de todas as empresas).

set -eu

DESTINO="${1:-./backups}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERRO: DATABASE_URL não definida. Sem ela não há o que copiar." >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERRO: pg_dump não encontrado. Instale o cliente do PostgreSQL (versão igual ou mais nova que a do banco)." >&2
  exit 1
fi

mkdir -p "$DESTINO"

# Mesmo formato de nome do backup do painel, hora de Brasília: backup-innochat-AAAA-MM-DD-HHhMMmSSs.dump
CARIMBO="$(TZ=America/Sao_Paulo date +%Y-%m-%d-%Hh%Mm%Ss)"
ARQUIVO="$DESTINO/backup-innochat-$CARIMBO.dump"

echo "[backup] gerando $ARQUIVO"

# --no-owner / --no-privileges: o dump precisa poder ser restaurado num banco novo, com outro
# usuário dono. Sem isso a restauração de emergência falha por causa de um papel que não existe lá.
pg_dump "$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --file="$ARQUIVO"

# Um dump truncado (disco cheio, conexão caída) existe, tem tamanho e não serve para nada. Ler o
# índice agora custa um segundo e evita descobrir isso durante um incidente.
if ! pg_restore --list "$ARQUIVO" >/dev/null 2>&1; then
  echo "ERRO: o dump recém-criado está ILEGÍVEL. Apagando para não dar falsa segurança." >&2
  rm -f "$ARQUIVO"
  exit 1
fi

TAMANHO="$(wc -c < "$ARQUIVO" | tr -d ' ')"
TABELAS="$(pg_restore --list "$ARQUIVO" | grep -c 'TABLE DATA' || true)"
echo "[backup] ok: $TAMANHO bytes, $TABELAS tabela(s) com dados"

# Zero tabelas com dados passa na leitura do índice, mas é um banco vazio: sintoma de banco errado.
if [ "$TABELAS" -eq 0 ]; then
  echo "ERRO: o dump não tem NENHUMA tabela com dados. Confira se a DATABASE_URL aponta para o banco certo." >&2
  exit 1
fi

echo "[backup] concluído: $ARQUIVO"
