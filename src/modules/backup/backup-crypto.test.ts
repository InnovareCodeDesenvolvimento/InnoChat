import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BackupCryptoError,
  HEADER_BYTES,
  backupKeyFileText,
  createDecryptStream,
  createEncryptStream,
  decryptFile,
  encryptFile,
  extractBackupKey,
  formatBackupKey,
  generateBackupKey,
  isEncryptedBackupName,
  keyFingerprint,
  parseBackupKey,
  readBackupFileFingerprint,
} from "./backup-crypto";

const SCRIPT = path.resolve(__dirname, "../../../scripts/decrypt-backup.mjs");
let dir: string;
const key = generateBackupKey();

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-crypto-test-"));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

let n = 0;
const p = (name: string) => path.join(dir, `${++n}-${name}`);

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function makeEncrypted(plain: Buffer, k = key): Promise<{ src: string; enc: string }> {
  const src = p("plain.dump");
  const enc = p("plain.dump.enc");
  await fs.writeFile(src, plain);
  await encryptFile(src, enc, k);
  return { src, enc };
}

async function expectCryptoError(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(BackupCryptoError);
  expect((error as BackupCryptoError).code).toBe(code);
  return error as BackupCryptoError;
}

describe("chave", () => {
  it("gera 32 bytes aleatórios e a impressão digital tem 8 hex", () => {
    expect(generateBackupKey()).toHaveLength(32);
    expect(generateBackupKey().equals(generateBackupKey())).toBe(false);
    expect(keyFingerprint(key)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("formata em 8 grupos e aceita de volta com hífen, espaço, quebra de linha ou colada sem nada", () => {
    const text = formatBackupKey(key);
    expect(text).toMatch(/^([0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    expect(parseBackupKey(text)?.equals(key)).toBe(true);
    expect(parseBackupKey(`  ${text.toUpperCase()}\n`)?.equals(key)).toBe(true);
    expect(parseBackupKey(key.toString("hex"))?.equals(key)).toBe(true);
    expect(parseBackupKey(text.slice(0, -1))).toBeNull();
    expect(parseBackupKey("zzzz")).toBeNull();
    expect(parseBackupKey(`${text}00`)).toBeNull();
  });

  it("acha a chave dentro do .txt baixado (linha CHAVE:) e não confunde com a impressão digital", () => {
    const txt = backupKeyFileText({ key, createdAt: new Date("2026-10-02T12:00:00Z") });
    expect(extractBackupKey(txt)?.equals(key)).toBe(true);
    expect(txt).toContain(keyFingerprint(key));
    expect(txt).toContain("Sem esta chave os backups não abrem");
    expect(txt).not.toContain("—");
    expect(extractBackupKey("nada de chave aqui")).toBeNull();
  });
});

describe("cifrar e decifrar em fluxo", () => {
  it("ida e volta: o dump volta byte a byte, e o cifrado não deixa o texto à vista", async () => {
    const plain = Buffer.from("PGDMP conteúdo do dump com acento: Ação, Müller 💉 ".repeat(50));
    const { enc } = await makeEncrypted(plain);
    const out = p("out.dump");
    await decryptFile(enc, out, key);
    expect((await fs.readFile(out)).equals(plain)).toBe(true);
    const cipher = await fs.readFile(enc);
    expect(cipher.length).toBe(plain.length + HEADER_BYTES + 16);
    expect(cipher.includes("Müller")).toBe(false);
    expect(cipher.subarray(0, 7).toString("latin1")).toBe("INNOBKP");
    expect(await readBackupFileFingerprint(enc)).toBe(keyFingerprint(key));
  });

  it("arquivo grande (vários blocos de leitura) e arquivo vazio fazem a ida e volta", async () => {
    const big = randomBytes(5 * 1024 * 1024 + 7);
    const { enc } = await makeEncrypted(big);
    const out = p("big.dump");
    await decryptFile(enc, out, key);
    expect((await fs.readFile(out)).equals(big)).toBe(true);

    const empty = await makeEncrypted(Buffer.alloc(0));
    const out2 = p("empty.dump");
    await decryptFile(empty.enc, out2, key);
    expect((await fs.readFile(out2)).length).toBe(0);
  });

  it("dois arquivos do mesmo conteúdo saem diferentes (IV novo a cada cópia)", async () => {
    const plain = Buffer.from("mesmo conteudo");
    const a = await makeEncrypted(plain);
    const b = await makeEncrypted(plain);
    expect((await fs.readFile(a.enc)).equals(await fs.readFile(b.enc))).toBe(false);
  });

  it("decifra mesmo com a entrada picada em pedaços de 1 byte (a tag é segurada até o fim)", async () => {
    const plain = Buffer.from("conteudo pequeno para picar");
    const { enc } = await makeEncrypted(plain);
    const cipher = await fs.readFile(enc);
    const chunks: Buffer[] = [];
    const sink = new (await import("node:stream")).Writable({
      write(chunk, _e, cb) {
        chunks.push(chunk as Buffer);
        cb();
      },
    });
    await pipeline(Readable.from(Array.from(cipher, (b) => Buffer.from([b]))), createDecryptStream(key), sink);
    expect(Buffer.concat(chunks).equals(plain)).toBe(true);
  });

  it("o stream de cifra também funciona picado (mesmo resultado que o decifrador espera)", async () => {
    const plain = randomBytes(1000);
    const parts: Buffer[] = [];
    const sink = new (await import("node:stream")).Writable({
      write(chunk, _e, cb) {
        parts.push(chunk as Buffer);
        cb();
      },
    });
    await pipeline(Readable.from([plain.subarray(0, 1), plain.subarray(1, 500), plain.subarray(500)]), createEncryptStream(key), sink);
    const enc = p("pieces.enc");
    await fs.writeFile(enc, Buffer.concat(parts));
    const out = p("pieces.dump");
    await decryptFile(enc, out, key);
    expect((await fs.readFile(out)).equals(plain)).toBe(true);
  });
});

describe("o que tem que reprovar (e não deixar texto para trás)", () => {
  it("chave errada: reprova pelo cabeçalho, diz as duas impressões digitais e não cria a saída", async () => {
    const { enc } = await makeEncrypted(Buffer.from("segredo"));
    const wrong = generateBackupKey();
    const out = p("wrong.dump");
    const error = await expectCryptoError(decryptFile(enc, out, wrong), "WRONG_KEY");
    expect(error.fileFingerprint).toBe(keyFingerprint(key));
    expect(error.message).toContain(keyFingerprint(key));
    expect(error.message).toContain(keyFingerprint(wrong));
    expect(await exists(out)).toBe(false);
  });

  it("adulteração em qualquer parte é detectada: texto cifrado, tag, IV e impressão digital", async () => {
    const { enc } = await makeEncrypted(randomBytes(4000));
    const original = await fs.readFile(enc);
    const flips: Array<[string, number, string]> = [
      ["no meio do texto cifrado", Math.floor(original.length / 2), "AUTH_FAILED"],
      ["no primeiro byte do texto", HEADER_BYTES, "AUTH_FAILED"],
      ["na tag", original.length - 1, "AUTH_FAILED"],
      ["no IV", 14, "AUTH_FAILED"],
      ["na impressão digital do cabeçalho", 9, "WRONG_KEY"],
    ];
    for (const [, offset, code] of flips) {
      const bad = Buffer.from(original);
      bad[offset] ^= 0x01;
      const badFile = p("bad.dump.enc");
      const out = p("bad.dump");
      await fs.writeFile(badFile, bad);
      await expectCryptoError(decryptFile(badFile, out, key), code);
      expect(await exists(out)).toBe(false);
    }
  });

  it("arquivo cortado (sem a tag, só com parte do texto, só com parte do cabeçalho) reprova", async () => {
    const { enc } = await makeEncrypted(randomBytes(3000));
    const original = await fs.readFile(enc);
    for (const length of [original.length - 1, original.length - 16, original.length - 17, Math.floor(original.length / 2), HEADER_BYTES + 5, HEADER_BYTES, 10]) {
      const cut = p("cut.dump.enc");
      const out = p("cut.dump");
      await fs.writeFile(cut, original.subarray(0, length));
      let error: unknown;
      try {
        await decryptFile(cut, out, key);
      } catch (e) {
        error = e;
      }
      expect(error, `cortado em ${length}`).toBeInstanceOf(BackupCryptoError);
      expect(["TRUNCATED", "AUTH_FAILED"]).toContain((error as BackupCryptoError).code);
      expect(await exists(out)).toBe(false);
    }
  });

  it("arquivo que não é nosso (dump comum, vazio, texto) é recusado como NOT_ENCRYPTED", async () => {
    for (const content of [Buffer.from("PGDMP\u0001\u000e\u0000 isto e um dump comum"), Buffer.alloc(0), Buffer.from("INN")]) {
      const file = p("plain.dump");
      await fs.writeFile(file, content);
      let error: unknown;
      try {
        await decryptFile(file, p("x.dump"), key);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BackupCryptoError);
      expect(["NOT_ENCRYPTED", "TRUNCATED"]).toContain((error as BackupCryptoError).code);
    }
    const plainFile = p("p.dump");
    await fs.writeFile(plainFile, "PGDMP");
    expect(await readBackupFileFingerprint(plainFile)).toBeNull();
  });

  it("versão desconhecida do formato é recusada com mensagem clara", async () => {
    const { enc } = await makeEncrypted(Buffer.from("x"));
    const bytes = await fs.readFile(enc);
    bytes[7] = 9;
    const file = p("v9.dump.enc");
    await fs.writeFile(file, bytes);
    const error = await expectCryptoError(decryptFile(file, p("v9.dump"), key), "UNSUPPORTED_VERSION");
    expect(error.message).toContain("versão 9");
  });

  it("chave de tamanho errado é recusada antes de tocar no arquivo", () => {
    expect(() => createEncryptStream(Buffer.alloc(16))).toThrow(BackupCryptoError);
    expect(() => createDecryptStream(Buffer.alloc(31))).toThrow(BackupCryptoError);
  });

  it("o nome .dump.enc é reconhecido", () => {
    expect(isEncryptedBackupName("backup-innochat-2026-10-02-03h00m00s.dump.enc")).toBe(true);
    expect(isEncryptedBackupName("backup-innochat-2026-10-02-03h00m00s.dump")).toBe(false);
  });
});

describe("script scripts/decrypt-backup.mjs fala o MESMO formato (testado nos dois sentidos)", () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

  async function keyFile(k = key) {
    const file = p("chave.txt");
    await fs.writeFile(file, backupKeyFileText({ key: k, createdAt: new Date() }));
    return file;
  }

  it("decifra o que o sistema cifrou, usando o .txt baixado da tela", async () => {
    const plain = randomBytes(300_000);
    const { enc } = await makeEncrypted(plain);
    const out = p("script-out.dump");
    const r = run([enc, "--chave", await keyFile(), "--saida", out]);
    expect(r.status, r.stderr).toBe(0);
    expect((await fs.readFile(out)).equals(plain)).toBe(true);
    expect(r.stdout).toContain(keyFingerprint(key));
  });

  it("o sistema decifra o que o script cifrou (--cifrar)", async () => {
    const plain = randomBytes(100_000);
    const src = p("s.dump");
    await fs.writeFile(src, plain);
    const enc = p("s.dump.enc");
    const r = run([src, "--cifrar", "--chave", await keyFile(), "--saida", enc]);
    expect(r.status, r.stderr).toBe(0);
    const out = p("s-out.dump");
    await decryptFile(enc, out, key);
    expect((await fs.readFile(out)).equals(plain)).toBe(true);
  });

  it("chave errada: sai com código 2, explica e não deixa arquivo (nem parcial)", async () => {
    const { enc } = await makeEncrypted(Buffer.from("segredo"));
    const out = p("wrong-out.dump");
    const r = run([enc, "--chave", await keyFile(generateBackupKey()), "--saida", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Chave errada");
    expect(await exists(out)).toBe(false);
    expect((await fs.readdir(dir)).some((f) => f.includes(".parcial-"))).toBe(false);
  });

  it("arquivo adulterado: sai com código 3 e não entrega o dump", async () => {
    const { enc } = await makeEncrypted(randomBytes(2000));
    const bytes = await fs.readFile(enc);
    bytes[HEADER_BYTES + 100] ^= 0xff;
    const bad = p("tampered.dump.enc");
    await fs.writeFile(bad, bytes);
    const out = p("tampered-out.dump");
    const r = run([bad, "--chave", await keyFile(), "--saida", out]);
    expect(r.status).toBe(3);
    expect(await exists(out)).toBe(false);
    expect((await fs.readdir(dir)).some((f) => f.includes(".parcial-"))).toBe(false);
  });

  it("aceita a chave pela variável BACKUP_KEY, não sobrescreve saída existente e --info mostra a impressão digital", async () => {
    const { enc } = await makeEncrypted(Buffer.from("abc"));
    const out = p("env-out.dump");
    const r = run([enc, "--saida", out], { BACKUP_KEY: formatBackupKey(key) });
    expect(r.status, r.stderr).toBe(0);
    const again = run([enc, "--saida", out], { BACKUP_KEY: formatBackupKey(key) });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("já existe");
    const info = run([enc, "--info"]);
    expect(info.status).toBe(0);
    expect(info.stdout).toContain(keyFingerprint(key));
    const noKey = run([enc, "--saida", p("nokey.dump")], { BACKUP_KEY: "" });
    expect(noKey.status).toBe(1);
  });
});
