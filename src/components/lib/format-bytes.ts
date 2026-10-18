/**
 * "15,0 MB" / "512 B" — tamanho de arquivo legível em pt-BR. Centralizado aqui porque o card de
 * cópias remotas e o diálogo de teste de integridade (Admin > Backup) precisam do mesmo formato.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1).replace(".", ",")} ${units[i]}`;
}
