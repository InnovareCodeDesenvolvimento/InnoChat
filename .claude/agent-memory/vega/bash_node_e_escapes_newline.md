---
name: bash-node-e-escapes-newline
description: Strings de código com \n gravadas por `node -e`/script via Bash viraram quebra de linha real; usar Edit/Write para trechos com \n
metadata:
  type: feedback
---

Ao inserir texto TypeScript com `\n` dentro de string (ex.: textos do bot) por script `node` rodado no Bash tool, o `\\n` virou uma quebra de linha REAL no arquivo e o esbuild acusou "Unterminated string literal". O mesmo script, relido, dizia que estava certo.

**Why:** a camada de execução do Bash des-escapa barras antes do Node.
**How to apply:** para qualquer trecho com `\n`, `\"` ou regex com barras, use a ferramenta Edit/Write (strings literais), não `node -e`/heredoc. Para Switch/JSON do n8n e para trocas sem barra, script Node é seguro. Conferir com Read o resultado, não com `sed`/`grep` pelo Bash.
