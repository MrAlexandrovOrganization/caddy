import { randomUUID, sign } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildSnapshot, readSnapshot } from "../sites/personality/model.mjs";

const tokenUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";
const headers = ["Участник", "Тип", "Энергия (E/I)", "Разум (N/S)", "Природа (T/F)", "Тактика (J/P)", "Идентичность (A/T)"];

const blank = value => value == null || (typeof value === "string" && !value.trim());

export function decodeRows(values) {
  const [header, ...rows] = values ?? [];
  if (!Array.isArray(header) || headers.some((label, index) => header[index]?.trim?.() !== label)) {
    throw new Error("Заголовки таблицы изменились. Ожидаются столбцы A:G, начиная со строки 6.");
  }
  return rows.flatMap((row, index) => {
    if (row.every(blank)) return [];
    const rowNumber = index + 7;
    const [name, type] = row;
    if (typeof name !== "string" || blank(name)) throw new Error(`В строке ${rowNumber} нужно имя.`);
    const code = blank(type) ? null : String(type).trim().toUpperCase();
    if (code !== null && !/^[EI][NS][TF][JP]-[AT]$/.test(code)) {
      throw new Error(`В строке ${rowNumber} некорректный тип.`);
    }
    const percentages = headers.slice(2).map((label, axis) => {
      const value = row[axis + 2];
      if (blank(value)) return null;
      if (code === null) throw new Error(`В строке ${rowNumber} указан процент, заполните тип.`);
      if (!Number.isFinite(value) || value < .5 || value > 1) {
        throw new Error(`В строке ${rowNumber} для шкалы «${label}» ожидается число от 50% до 100%.`);
      }
      return Math.round(value * 10_000) / 100;
    });
    return [[name.trim(), code, percentages]];
  });
}

function encodeJwtSegment(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function assertion(account) {
  if (account?.type !== "service_account" || typeof account.client_email !== "string" ||
      !account.private_key?.startsWith?.("-----BEGIN PRIVATE KEY-----")) {
    throw new Error("Ожидается JSON-ключ выделенного сервисного аккаунта.");
  }
  const iat = Math.floor(Date.now() / 1000);
  const metadata = encodeJwtSegment({ alg: "RS256", typ: "JWT", kid: account.private_key_id });
  const claims = encodeJwtSegment({ iss: account.client_email, scope, aud: tokenUrl, iat, exp: iat + 600 });
  const unsigned = `${metadata}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), account.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

async function googleJson(url, options, label) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12_000), redirect: "error" });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: некорректный JSON-ответ.`);
  }
}

async function readSheetRows(config, account) {
  if (typeof config.spreadsheetId !== "string" || !/^[\w-]+$/.test(config.spreadsheetId) ||
      typeof config.sheetName !== "string" || !config.sheetName.trim()) {
    throw new Error("Укажите spreadsheetId и sheetName в config.json.");
  }
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: assertion(account),
  });
  const token = await googleJson(tokenUrl, { method: "POST", body }, "Авторизация Google");
  if (typeof token.access_token !== "string" || !token.access_token) {
    throw new Error("Google не выдал токен сервисного аккаунта.");
  }
  const range = `'${config.sheetName.replaceAll("'", "''")}'!A6:G`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${config.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const result = await googleJson(url, { headers: { Authorization: `Bearer ${token.access_token}` } }, "Чтение Google Таблицы");
  return decodeRows(result.values);
}

async function readConfig(path) {
  const contents = await readFile(path, "utf8");
  try {
    return JSON.parse(contents);
  } catch {
    throw new Error(`Некорректный JSON в конфигурации ${path}.`);
  }
}

export async function publishSnapshot(path, snapshot) {
  readSnapshot(snapshot);
  const data = JSON.stringify(snapshot) + "\n";
  const previous = await readFile(path, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (previous === data) return false;
  const pending = `${path}.${randomUUID()}.next`;
  try {
    await writeFile(pending, data, { mode: 0o600, flag: "wx" });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
  return true;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const [, , configDir, output] = process.argv;
    const config = await readConfig(join(configDir, "config.json"));
    const account = await readConfig(join(configDir, "service-account.json"));
    const snapshot = buildSnapshot(await readSheetRows(config, account));
    if (await publishSnapshot(output, snapshot)) {
      console.log(`Обновлён снимок: ${snapshot.profiles.length} участников, ${snapshot.measurements.length} пар с процентами.`);
    }
  } catch (error) {
    console.error(`Синхронизация результатов: ${error.message}`);
    process.exitCode = 1;
  }
}
