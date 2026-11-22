import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSnapshot } from "../sites/personality/model.mjs";
import { decodeRows, publishSnapshot } from "./sync-personality.mjs";

const headers = ["Участник", "Тип", "Энергия (E/I)", "Разум (N/S)", "Природа (T/F)", "Тактика (J/P)", "Идентичность (A/T)"];

test("numeric Sheet cells preserve blanks, sides, and fractional percentages", () => {
  const rows = decodeRows([
    headers,
    [" А ", "entp-a", .79, .575, "", .6],
    [],
    ["Б", "", ""],
    ["В", "ISFJ-T", .75, .61, .72, .55, .64],
  ]);
  assert.deepEqual(rows, [
    ["А", "ENTP-A", [79, 57.5, null, 60, null]],
    ["Б", null, [null, null, null, null, null]],
    ["В", "ISFJ-T", [75, 61, 72, 55, 64]],
  ]);
  const snapshot = buildSnapshot(rows);
  assert.deepEqual(snapshot.profiles, [["А", "ENTP-A"], ["Б", null], ["В", "ISFJ-T"]]);
  assert.equal(snapshot.measurements[0][3], 11);
});

test("a wrong range, missing type, or malformed percentages fail before publication", () => {
  assert.throws(() => decodeRows([["Участник", "Тип"]]), /Заголовки/);
  assert.throws(() => decodeRows([headers, ["А", "", .79]]), /заполните тип/);
  assert.throws(() => decodeRows([headers, ["А", "ENTP-A", 79]]), /от 50% до 100%/);
  assert.throws(() => decodeRows([headers, ["", "ENTP-A"]]), /нужно имя/);
});

test("publish replaces the snapshot atomically and leaves it alone on no change or invalid data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "personality-sync-test-"));
  try {
    const path = join(directory, "profiles.json");
    const snapshot = buildSnapshot(decodeRows([headers, ["А", "ENTP-A"], ["Б", "ISFJ-T"]]));
    assert.equal(await publishSnapshot(path, snapshot), true);
    const previous = await readFile(path, "utf8");
    const previousInode = (await stat(path)).ino;
    assert.equal(await publishSnapshot(path, snapshot), false);
    assert.equal((await stat(path)).ino, previousInode);
    await assert.rejects(() => publishSnapshot(path, { profiles: [] }));
    assert.equal(await readFile(path, "utf8"), previous);
    const renamed = { ...snapshot, profiles: [["А.", "ENTP-A"], ["Б", "ISFJ-T"]] };
    assert.equal(await publishSnapshot(path, renamed), true);
    assert.notEqual((await stat(path)).ino, previousInode);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), renamed);
    assert.deepEqual(await readdir(directory), ["profiles.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
