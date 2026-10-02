#!/usr/bin/env node
/**
 * Abre (decifra) um backup do InnoChat. Só precisa de Node: não depende do projeto instalado.
 *
 *   node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> [--saida <backup.dump>]
 *   node scripts/decrypt-backup.mjs <backup.dump.enc> --info          (mostra a impressão digital da chave do arquivo)
 *   node scripts/decrypt-backup.mjs <backup.dump> --cifrar --chave <arquivo> [--saida <backup.dump.enc>]
 *
 * `--chave` aponta para o arquivo .txt baixado em Admin > Backup (a linha "CHAVE: ...") ou para um
 * arquivo que tenha só a chave. A chave NUNCA vai por argumento (apareceria no `ps`); se preferir não
 * ter arquivo, exporte BACKUP_KEY com a chave e omita --chave.
 *
 * O resultado só ganha o nome final DEPOIS de a verificação de integridade passar: um arquivo
 * adulterado, cortado ou aberto com a chave errada não deixa nada para trás.
 *
 * FORMATO (versão 1), o mesmo de src/modules/backup/backup-crypto.ts (testados um contra o outro):
 *   "INNOBKP" | versão (1 byte) | impressão digital (4 bytes) | IV (12) | AES-256-GCM | tag (16)
 * O cabeçalho sem o IV é dado autenticado (AAD).
 *
 * Códigos de saída: 0 ok, 1 erro de uso, 2 chave errada, 3 arquivo adulterado/cortado/não cifrado.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync, renameSync, rmSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("INNOBKP", "latin1");
const VERSION = 1;
const FP_BYTES = 4;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD_BYTES = MAGIC.length + 1 + FP_BYTES;
const HEADER_BYTES = AAD_BYTES + IV_BYTES;

class CryptoError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function fingerprintOf(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, FP_BYTES * 2);
}

function parseKey(text) {
  const clean = text.replace(/[\s-]/g, "");
  return /^[0-9a-fA-F]{64}$/.test(clean) ? Buffer.from(clean, "hex") : null;
}

function extractKey(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*chave\s*:\s*(.+)$/i);
    if (m) {
      const key = parseKey(m[1]);
      if (key) return key;
    }
  }
  return parseKey(text);
}

function createEncryptStream(key) {
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), createHash("sha256").update(key).digest().subarray(0, FP_BYTES), iv]);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(header.subarray(0, AAD_BYTES));
  let started = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!started) {
        this.push(header);
        started = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!started) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

function createDecryptStream(key) {
  const expected = fingerprintOf(key);
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher = null;

  function open() {
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new CryptoError("Este arquivo não é um backup cifrado do InnoChat (a marca do formato não bate). Se é um .dump comum, ele não precisa de chave.", 3);
    }
    const version = head[MAGIC.length];
    const fileFp = head.subarray(MAGIC.length + 1, AAD_BYTES).toString("hex");
    if (version !== VERSION) throw new CryptoError(`Este backup usa a versão ${version} do formato, e este script só abre a ${VERSION}. Use um script mais novo.`, 3);
    if (fileFp !== expected) {
      throw new CryptoError(`Chave errada: este backup foi cifrado com a chave de impressão digital ${fileFp}, e a chave informada é a ${expected}.`, 2);
    }
    decipher = createDecipheriv("aes-256-gcm", key, head.subarray(AAD_BYTES, HEADER_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(head.subarray(0, AAD_BYTES));
  }

  return new Transform({
    transform(chunk, _enc, cb) {
      try {
        let data = chunk;
        if (!decipher) {
          head = Buffer.concat([head, chunk]);
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length));
          if (!probe.equals(MAGIC.subarray(0, probe.length))) open();
          if (head.length < HEADER_BYTES) return cb();
          open();
          data = head.subarray(HEADER_BYTES);
          head = Buffer.alloc(0);
        }
        tail = Buffer.concat([tail, data]);
        if (tail.length > TAG_BYTES) {
          const release = tail.subarray(0, tail.length - TAG_BYTES);
          tail = tail.subarray(tail.length - TAG_BYTES);
          cb(null, decipher.update(release));
        } else {
          cb();
        }
      } catch (error) {
        cb(error);
      }
    },
    flush(cb) {
      try {
        if (!decipher) {
          const probe = head.subarray(0, Math.min(head.length, MAGIC.length));
          if (probe.length === 0 || !probe.equals(MAGIC.subarray(0, probe.length))) open();
          throw new CryptoError("O arquivo está cortado: termina antes do fim do cabeçalho.", 3);
        }
        if (tail.length < TAG_BYTES) throw new CryptoError("O arquivo está cortado: falta o final, onde fica a prova de integridade.", 3);
        decipher.setAuthTag(tail);
        let last;
        try {
          last = decipher.final();
        } catch {
          throw new CryptoError("Falha na verificação: o arquivo foi alterado, está corrompido ou está incompleto. Não use este backup.", 3);
        }
        cb(null, last);
      } catch (error) {
        cb(error);
      }
    },
  });
}

function readHeaderFingerprint(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEADER_BYTES);
    const n = readSync(fd, buf, 0, HEADER_BYTES, 0);
    if (n < HEADER_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) return null;
    return buf.subarray(MAGIC.length + 1, AAD_BYTES).toString("hex");
  } finally {
    closeSync(fd);
  }
}

function fail(message, code = 1) {
  console.error(`ERRO: ${message}`);
  process.exit(code);
}

function usage() {
  console.error("Uso:\n  node scripts/decrypt-backup.mjs <backup.dump.enc> --chave <arquivo> [--saida <backup.dump>]\n  node scripts/decrypt-backup.mjs <backup.dump.enc> --info\n  node scripts/decrypt-backup.mjs <backup.dump> --cifrar --chave <arquivo> [--saida <backup.dump.enc>]");
  process.exit(1);
}

const args = process.argv.slice(2);
let input = null;
let keyFile = null;
let output = null;
let encrypt = false;
let info = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === "--chave") keyFile = args[++i] ?? usage();
  else if (a === "--saida") output = args[++i] ?? usage();
  else if (a === "--cifrar") encrypt = true;
  else if (a === "--info") info = true;
  else if (a.startsWith("--")) usage();
  else if (input === null) input = a;
  else usage();
}
if (!input) usage();
if (!existsSync(input) || !statSync(input).isFile()) fail(`arquivo não encontrado: ${input}`);

if (info) {
  const fp = readHeaderFingerprint(input);
  if (!fp) fail("este arquivo não é um backup cifrado do InnoChat.", 3);
  console.log(`Backup cifrado do InnoChat. Impressão digital da chave: ${fp}`);
  process.exit(0);
}

let key = null;
if (keyFile) {
  if (!existsSync(keyFile)) fail(`arquivo da chave não encontrado: ${keyFile}`);
  key = extractKey(readFileSync(keyFile, "utf8"));
  if (!key) fail("não achei uma chave válida no arquivo (esperava a linha CHAVE: com 64 caracteres hexadecimais).");
} else if (process.env.BACKUP_KEY) {
  key = extractKey(process.env.BACKUP_KEY);
  if (!key) fail("BACKUP_KEY não tem uma chave válida (64 caracteres hexadecimais).");
} else {
  fail("falta a chave. Use --chave <arquivo> (o .txt baixado em Admin > Backup) ou exporte BACKUP_KEY.");
}

const finalPath = output ?? (encrypt ? `${input}.enc` : input.replace(/\.enc$/, "") === input ? `${input}.dump` : input.replace(/\.enc$/, ""));
if (existsSync(finalPath)) fail(`o arquivo de saída já existe e não vou sobrescrever: ${finalPath}`);
const partial = `${finalPath}.parcial-${process.pid}`;

try {
  await pipeline(createReadStream(input), encrypt ? createEncryptStream(key) : createDecryptStream(key), createWriteStream(partial, { mode: 0o600 }));
  renameSync(partial, finalPath);
  console.log(`${encrypt ? "Cifrado" : "Decifrado e verificado"}: ${finalPath} (impressão digital da chave: ${fingerprintOf(key)})`);
} catch (error) {
  rmSync(partial, { force: true });
  if (error instanceof CryptoError) fail(error.message, error.exitCode);
  fail(`não deu para processar o arquivo: ${error instanceof Error ? error.message : String(error)}`);
}
