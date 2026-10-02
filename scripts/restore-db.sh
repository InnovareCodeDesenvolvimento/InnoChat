#!/usr/bin/env sh
#
# Restauração do banco do InnoChat (abordagem do Parque das Feiras).
#
# Uso:
#   ./scripts/restore-db.sh <arquivo.dump> <url-do-banco-destino> --confirmar
#
# POR QUE O DESTINO É UM ARGUMENTO, E NÃO A DATABASE_URL DO AMBIENTE:
# restaurar é destrutivo — apaga o conteúdo atual antes de repor. Se este
# script lesse a DATABASE_URL sozinho, bastaria rodá-lo por engano no terminal
# errado para reescrever a produção. Obrigar a digitar o destino faz a pessoa
# olhar para onde está mandando.
#
# A flag --confirmar existe pelo mesmo motivo: nenhuma restauração acontece
# por acidente de histórico do shell.

set -eu

ARQUIVO="${1:-}"
DESTINO="${2:-}"
CONFIRMACAO="${3:-}"

if [ -z "$ARQUIVO" ] || [ -z "$DESTINO" ]; then
  echo "Uso: $0 <arquivo.dump> <url-do-banco-destino> --confirmar" >&2
  exit 1
fi

if [ ! -f "$ARQUIVO" ]; then
  echo "ERRO: arquivo não encontrado: $ARQUIVO" >&2
  exit 1
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "ERRO: pg_restore não encontrado. Instale o cliente do PostgreSQL (versão igual ou mais nova que a do banco)." >&2
  exit 1
fi

# Confere o dump ANTES de destruir qualquer coisa. Descobrir que o arquivo está
# corrompido depois de apagar o banco seria a pior sequência possível.
if ! pg_restore --list "$ARQUIVO" >/dev/null 2>&1; then
  echo "ERRO: dump ilegível ou corrompido. NADA foi alterado no destino." >&2
  exit 1
fi

TABELAS="$(pg_restore --list "$ARQUIVO" | grep -c 'TABLE DATA' || true)"

# Esconde a senha ao ecoar o destino.
DESTINO_SEGURO="$(echo "$DESTINO" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#')"

echo "Vai restaurar:"
echo "  arquivo : $ARQUIVO ($TABELAS tabela(s) com dados)"
echo "  destino : $DESTINO_SEGURO"
echo ""
echo "ISTO APAGA o conteúdo atual do banco de destino."

if [ "$CONFIRMACAO" != "--confirmar" ]; then
  echo "" >&2
  echo "Parado: falta --confirmar como terceiro argumento." >&2
  exit 1
fi

echo "[restore] restaurando..."

# --clean --if-exists: derruba os objetos antes de recriar, sem reclamar do que
# não existe (banco vazio é o caso normal numa máquina nova).
#
# --exit-on-error NÃO é usado de propósito: o dump vem com --no-owner, e o
# pg_restore emite erros benignos de permissão/extensão que não impedem os
# dados de voltar. Em vez de abortar por causa deles, conferimos o RESULTADO
# logo abaixo — que é o que realmente importa.
set +e
pg_restore \
  --dbname="$DESTINO" \
  --clean --if-exists \
  --no-owner --no-privileges \
  "$ARQUIVO"
CODIGO=$?
set -e

if [ "$CODIGO" -ne 0 ]; then
  echo "[restore] pg_restore terminou com avisos (código $CODIGO) — conferindo o resultado..."
fi

# A prova real: as tabelas voltaram com linhas?
TABELAS_COM_DADOS="$(psql "$DESTINO" -tAc "
  SELECT count(*) FROM pg_stat_user_tables WHERE n_live_tup > 0;
" 2>/dev/null || echo "?")"

echo "[restore] tabelas com dados no destino: $TABELAS_COM_DADOS"

if [ "$TABELAS_COM_DADOS" = "0" ]; then
  echo "ERRO: o banco de destino ficou VAZIO. A restauração não valeu." >&2
  exit 1
fi

echo "[restore] concluído."
echo ""
echo "Próximo passo: suba o painel. Ele roda 'prisma migrate deploy' no boot e"
echo "alinha o schema, caso o dump seja de uma versão anterior."
