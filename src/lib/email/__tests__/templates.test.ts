import { describe, expect, it } from "vitest";
import {
  invoiceDueReminderEmail,
  invoiceGeneratedEmail,
  passwordResetEmail,
  paymentConfirmedEmail,
  subscriptionCancelEmail,
  subscriptionSuspendedEmail,
  teamInviteEmail,
  verificationEmail,
} from "../templates";
import type { EmailContext } from "../layout";

const ctx: EmailContext = {
  baseUrl: "https://app.exemplo.com.br",
  legal: { companyLegalName: "Innovare Code LTDA", companyCnpj: "12.345.678/0001-90" },
};
const URL_ = "https://app.exemplo.com.br/acao?token=abc123";
const PIX = "00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-4266141740005204000053039865802BR5920InnoChat6009SAO PAULO62070503***6304ABCD";

const all = () => [
  { name: "verification", cta: URL_, mail: verificationEmail({ verifyUrl: URL_, ctx }) },
  { name: "reset", cta: URL_, mail: passwordResetEmail({ resetUrl: URL_, ctx }) },
  { name: "invite", cta: URL_, mail: teamInviteEmail({ tenantName: "Studio Bela", inviteUrl: URL_, ctx }) },
  { name: "invoice", cta: URL_, mail: invoiceGeneratedEmail({ tenantName: "Studio Bela", amountReais: "R$ 99,90", dueDateBr: "05/10/2026", pixCopyPaste: PIX, billingUrl: URL_, ctx }) },
  { name: "reminder-tomorrow", cta: URL_, mail: invoiceDueReminderEmail({ tenantName: "Studio Bela", amountReais: "R$ 99,90", dueDateBr: "05/10/2026", billingUrl: URL_, dueToday: false, ctx }) },
  { name: "reminder-today", cta: URL_, mail: invoiceDueReminderEmail({ tenantName: "Studio Bela", amountReais: "R$ 99,90", dueDateBr: "05/10/2026", billingUrl: URL_, dueToday: true, ctx }) },
  { name: "suspended", cta: URL_, mail: subscriptionSuspendedEmail({ tenantName: "Studio Bela", billingUrl: URL_, ctx }) },
  { name: "trial-ended", cta: URL_, mail: subscriptionSuspendedEmail({ tenantName: "Studio Bela", billingUrl: URL_, trialNotConverted: true, cancelInDays: 60, ctx }) },
  { name: "payment", cta: URL_, mail: paymentConfirmedEmail({ tenantName: "Studio Bela", amountReais: "R$ 99,90", paidDateBr: "29/09/2026", activeUntilBr: "29/10/2026", billingUrl: URL_, ctx }) },
];

describe("templates de e-mail", () => {
  for (const { name, cta, mail } of all()) {
    describe(name, () => {
      it("tem subject, preheader (oculto no HTML) e versão texto", () => {
        expect(mail.subject.length).toBeGreaterThan(5);
        expect(mail.preheader.length).toBeGreaterThan(10);
        expect(mail.html).toContain(mail.preheader);
        expect(mail.html).toContain("display:none");
        expect(mail.text.length).toBeGreaterThan(40);
      });

      it("CTA aponta para a URL certa no botão, no VML do Outlook e no texto", () => {
        expect(mail.html).toContain(`href="${cta}"`);
        expect(mail.html).toContain("v:roundrect");
        expect(mail.text).toContain(cta);
      });

      it("não vaza undefined/null/[object Object] no HTML nem no texto", () => {
        for (const out of [mail.html, mail.text]) {
          expect(out).not.toMatch(/undefined|\bnull\b|\[object/);
        }
      });

      it("tem cabeçalho com logo absoluto + alt, dark mode e rodapé completo", () => {
        expect(mail.html).toContain('src="https://app.exemplo.com.br/marca/email-logo.png"');
        expect(mail.html).toContain('alt="InnoChat"');
        expect(mail.html).toContain('name="color-scheme"');
        expect(mail.html).toContain("prefers-color-scheme:dark");
        expect(mail.html).toContain("https://innovarecode.com.br");
        expect(mail.html).toContain("https://app.exemplo.com.br/termos");
        expect(mail.html).toContain("https://app.exemplo.com.br/privacidade");
        expect(mail.html).toContain("Innovare Code LTDA");
        expect(mail.html).toContain("CNPJ 12.345.678/0001-90");
        expect(mail.html).toContain("Você recebeu este e-mail porque");
        expect(mail.text).toContain("Desenvolvido por InnovareCode");
        expect(mail.text).toContain("Você recebeu este e-mail porque");
      });
    });
  }

  it("fatura traz cartão com valor/vencimento e Pix quebrável com instrução", () => {
    const { html, text } = invoiceGeneratedEmail({ tenantName: "X", amountReais: "R$ 99,90", dueDateBr: "05/10/2026", pixCopyPaste: PIX, billingUrl: URL_, ctx });
    expect(html).toContain("R$ 99,90");
    expect(html).toContain("05/10/2026");
    expect(html).toContain(PIX);
    expect(html).toContain("word-break:break-all");
    expect(html).toContain("cole no app do seu banco");
    expect(text).toContain(PIX);
  });

  it("fatura sem Pix não mostra bloco de Pix nem placeholder", () => {
    const { html, text } = invoiceGeneratedEmail({ tenantName: "X", amountReais: "R$ 99,90", dueDateBr: "05/10/2026", pixCopyPaste: null, billingUrl: URL_, ctx });
    expect(html).not.toContain("Pix copia e cola");
    expect(text).not.toContain("copie e cole");
  });

  it("lembrete diferencia vence hoje x amanhã; teste terminou cita o prazo de encerramento", () => {
    expect(all().find((a) => a.name === "reminder-today")!.mail.subject).toContain("vence hoje");
    expect(all().find((a) => a.name === "reminder-tomorrow")!.mail.subject).toContain("vence amanhã");
    const trial = all().find((a) => a.name === "trial-ended")!.mail;
    expect(trial.subject).toContain("Seu teste terminou");
    expect(trial.text).toContain("60 dias");
  });

  it("recibo mostra valor, data do pagamento e até quando a assinatura está ativa", () => {
    const { subject, html, text } = all().find((a) => a.name === "payment")!.mail;
    expect(subject).toBe("Pagamento confirmado (Studio Bela)");
    for (const out of [html, text]) {
      expect(out).toContain("R$ 99,90");
      expect(out).toContain("29/09/2026");
      expect(out).toContain("29/10/2026");
    }
  });

  it("verificação, convite e recibo têm o Inno falando", () => {
    for (const name of ["verification", "invite", "payment"]) {
      const { html } = all().find((a) => a.name === name)!.mail;
      expect(html).toContain("email-inno-avatar.png");
    }
  });

  it("sem contexto (URL pública desconhecida) o e-mail sai igual: logo vira texto e rodapé omite links/dados jurídicos", () => {
    const { html, text } = verificationEmail({ verifyUrl: URL_ });
    expect(html).not.toContain("<img");
    expect(html).toContain("InnoChat");
    expect(html).not.toContain("/termos");
    expect(html).not.toContain("CNPJ");
    expect(text).not.toContain("undefined");
  });

  it("dados jurídicos vazios são omitidos do rodapé", () => {
    const { html } = verificationEmail({ verifyUrl: URL_, ctx: { baseUrl: "https://a.com", legal: { companyLegalName: null, companyCnpj: "  " } } });
    expect(html).not.toContain("CNPJ");
    expect(html).not.toMatch(/null/);
  });

  describe("escape de HTML em todo dado dinâmico", () => {
    const evil = `<script>alert("x")</script><img src=x onerror=alert(1)> & "aspas"`;
    const evilCtx: EmailContext = { baseUrl: "https://a.com", legal: { companyLegalName: evil, companyCnpj: evil } };
    const evilUrl = `https://a.com/x?a=1&b="><script>alert(1)</script>`;

    const mails = [
      teamInviteEmail({ tenantName: evil, inviteUrl: evilUrl, ctx: evilCtx }),
      invoiceGeneratedEmail({ tenantName: evil, amountReais: evil, dueDateBr: evil, pixCopyPaste: evil, billingUrl: evilUrl, ctx: evilCtx }),
      invoiceDueReminderEmail({ tenantName: evil, amountReais: evil, dueDateBr: evil, billingUrl: evilUrl, dueToday: true, ctx: evilCtx }),
      subscriptionSuspendedEmail({ tenantName: evil, billingUrl: evilUrl, trialNotConverted: true, cancelInDays: 60, ctx: evilCtx }),
      subscriptionSuspendedEmail({ tenantName: evil, billingUrl: evilUrl, ctx: evilCtx }),
      paymentConfirmedEmail({ tenantName: evil, amountReais: evil, paidDateBr: evil, activeUntilBr: evil, billingUrl: evilUrl, ctx: evilCtx }),
      verificationEmail({ verifyUrl: evilUrl, ctx: evilCtx }),
      passwordResetEmail({ resetUrl: evilUrl, ctx: evilCtx }),
    ];

    it("nenhuma tag injetada sobrevive no HTML", () => {
      for (const { html } of mails) {
        expect(html).not.toContain("<script>alert");
        expect(html).not.toContain("<img src=x");
        expect(html).not.toContain('onerror=alert(1)>');
        expect(html).toContain("&lt;script&gt;");
      }
    });

    it("URL com aspas não escapa do atributo href", () => {
      for (const { html } of mails.filter((m) => m.html.includes("a=1&amp;b="))) {
        expect(html).not.toMatch(/href="[^"]*"><script/);
      }
    });

    it("esquema não-http vira '#'", () => {
      const { html } = verificationEmail({ verifyUrl: "javascript:alert(1)", ctx });
      expect(html).not.toContain('href="javascript:');
    });
  });
});

describe("subscriptionCancelEmail", () => {
  const base = { tenantName: "Salão da Ana", endsAtBr: "20/11/2026", retentionDays: 90, clientsUrl: "https://app.exemplo.com.br/salao/clientes", billingUrl: "https://app.exemplo.com.br/salao/assinatura", ctx };

  it("agendado: traz a data, o prazo de 90 dias, o lembrete do CSV e como desfazer", () => {
    const mail = subscriptionCancelEmail({ ...base, immediate: false });
    expect(mail.subject).toContain("20/11/2026");
    for (const body of [mail.text, mail.html]) {
      expect(body).toContain("20/11/2026");
      expect(body).toContain("90 dias");
      expect(body).toContain("CSV");
    }
    expect(mail.text).toContain("desfazer o cancelamento");
    expect(mail.text).toContain(base.clientsUrl);
  });

  it("imediato: sem lembrete de exportar, com chamada para reativar", () => {
    const mail = subscriptionCancelEmail({ ...base, immediate: true });
    expect(mail.subject).toBe("Assinatura cancelada (Salão da Ana)");
    expect(mail.text).not.toContain("CSV");
    expect(mail.text).toContain("reative");
  });

  it("escapa o nome da empresa no HTML", () => {
    const mail = subscriptionCancelEmail({ ...base, tenantName: "<script>x</script>", immediate: false });
    expect(mail.html).not.toContain("<script>x</script>");
  });
});
