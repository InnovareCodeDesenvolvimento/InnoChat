---
name: email-sent-means-only-smtp-accepted
description: "SENT" da régua só provava que o SMTP aceitou; desde 2026-10-02 sendMail confere accepted/rejected e a régua grava providerMessageId + providerResponse
metadata:
  type: project
---

Incidente 2026-10-02: avisos "Teste grátis" (TRIAL_DAY1, TRIAL_T1) marcados SENT para @gmail.com não chegaram, enquanto e-mails de conta (verificação, senha, boas-vindas) chegam.

**Causa raiz não provada.** Comparei o MIME bruto (nodemailer streamTransport) de verificação, redefinição e dos 2 avisos de teste: mesma estrutura, mesmo From, linhas até 76, sem caracteres de controle. Único traço: assunto dos avisos tem acento (encoded-word, normal). Não há dry-run nem caminho que marque SENT sem `sendMail` resolver. Hipóteses que sobram: filtro/limite do Titan ou do Gmail por conteúdo ou volume (envio em rajada pelo tick), endereço de destino.

**Correção/instrumentação:** `sendMail` devolve `SendMailResult` (sent, messageId, smtpResponse sem e-mails, rejectedCount, accepted/rejected, failure). `sent` só se o destinatário está em `accepted` e `rejected` vazio. Coluna aditiva `billing_notices.providerResponse`. Código de falha `EMAIL_REJECTED`. Admin > Configurações tem "Enviar e-mail de teste" (`sendSmtpTestEmailAction`, 5/10min).

**Como evitar:** nunca tratar "promise resolveu" como entregue; guardar evidência do servidor. Mocks de `sendMail` em testes de integração devem devolver o formato novo (helper `fakeSendMail` em tests/integration/dunning.helpers.ts, modo "rejected").

DNS de innovarecode.com.br (2026-10-02): SPF `v=spf1 include:spf.titan.email ~all`, DKIM selector `titan1` presente, DMARC `p=none; rua=mailto:no-reply@innovarecode.com.br` (existe; os relatórios do Google caem na caixa no-reply).
