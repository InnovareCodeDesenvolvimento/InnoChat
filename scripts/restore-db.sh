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
#
# SENHA FORA DOS ARGUMENTOS: o script nunca passa a senha ao pg_restore/psql
# por argumento (`ps` de qualquer usuário da máquina a mostraria). Se a URL
# trouxer senha, ela é tirada da URL e vai pela variável PGPASSWORD (só o
# ambiente do processo). Melhor ainda: passe a URL SEM senha e exporte
# PGPASSWORD antes de rodar.

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

# Separa a senha da URL (printf é builtin e sed/awk leem da entrada padrão: a senha nunca vira argumento de processo).
# Sem usuário:senha@ na URL, vale o PGPASSWORD que já estiver no ambiente.
SENHA_NA_URL="$(printf '%s' "$DESTINO" | sed -n -E 's#^[A-Za-z][A-Za-z0-9+.-]*://[^:@/]+:([^@]*)@.*#\1#p')"
if [ -n "$SENHA_NA_URL" ]; then
  # A senha numa URL vem com %XX; o PGPASSWORD é literal.
  PGPASSWORD="$(printf '%s' "$SENHA_NA_URL" | LC_ALL=C awk '{
    hex = "0123456789ABCDEF"; out = ""; s = $0; n = length(s); i = 1
    while (i <= n) {
      c = substr(s, i, 1)
      if (c == "%" && i + 2 <= n) {
        a = index(hex, toupper(substr(s, i + 1, 1))) - 1
        b = index(hex, toupper(substr(s, i + 2, 1))) - 1
        if (a >= 0 && b >= 0) { out = out sprintf("%c", a * 16 + b); i += 3; continue }
      }
      out = out c; i++
    }
    printf "%s", out
  }')"
  export PGPASSWORD
  DESTINO="$(printf '%s' "$DESTINO" | sed -E 's#^([A-Za-z][A-Za-z0-9+.-]*://[^:@/]+):[^@]*@#\1@#')"
fi
unset SENHA_NA_URL
# `DESTINO` já não tem senha: pode ser ecoado e passado como argumento.
DESTINO_SEGURO="$DESTINO"

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
