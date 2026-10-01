import { Fragment } from "react";

/**
 * Formatação de texto do WhatsApp: `*negrito*`, `_itálico_`, `~riscado~`. Pura, sem
 * `dangerouslySetInnerHTML` — tudo vira elemento React. Só trata marcas na mesma linha, que é o
 * que o bot gera.
 */
const TOKEN = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;

function renderLine(line: string, keyBase: string): React.ReactNode[] {
  return line.split(TOKEN).map((part, index) => {
    const key = `${keyBase}-${index}`;
    if (part.length > 2) {
      const mark = part[0];
      const inner = part.slice(1, -1);
      if (mark === "*" && part.endsWith("*")) return <strong key={key} className="font-semibold">{renderLine(inner, key)}</strong>;
      if (mark === "_" && part.endsWith("_")) return <em key={key}>{renderLine(inner, key)}</em>;
      if (mark === "~" && part.endsWith("~")) return <s key={key}>{renderLine(inner, key)}</s>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function WhatsappText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, index) => (
        <Fragment key={index}>
          {renderLine(line, `l${index}`)}
          {index < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </>
  );
}
