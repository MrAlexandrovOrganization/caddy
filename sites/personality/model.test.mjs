import assert from "node:assert/strict";
import test from "node:test";
import { compare, connections, readProfiles } from "./model.mjs";

const people = readProfiles([["А", "ENFJ-A"], ["Б", "ENFJ-T"], ["В", "INFJ-A"], ["Г", "ISTP-T"]]);
const [first, second, third] = people;

test("A/T is visible in the details and counted only when enabled", () => {
  const withoutIdentity = compare(first, second, false);
  assert.deepEqual([withoutIdentity.score, withoutIdentity.total], [4, 4]);
  assert.deepEqual(withoutIdentity.axes.at(-1), {
    label: "Идентичность (A/T)", first: "A", second: "T", counted: false,
  });
  const withIdentity = compare(first, third, true);
  assert.deepEqual([withIdentity.score, withIdentity.total], [4, 5]);
});

test("graph edges are undirected, unique and restricted to the requested scope", () => {
  const team = connections(people, false, 3);
  assert.deepEqual(team.map(({ from, to, score }) => [from, to, score]), [[0, 1, 4], [0, 2, 3], [1, 2, 3]]);
  assert.deepEqual(connections(people, false, 3, 0), team.slice(0, 2));
  assert.deepEqual(connections(people, true, 5), []);
});

test("missing, duplicate and malformed rows fail validation", () => {
  assert.throws(() => readProfiles([]));
  assert.throws(() => readProfiles([["А", "ENFJ-A"], [" А ", "INTJ-T"]]));
  assert.throws(() => readProfiles([["А", "ENFJ-A"], ["Б", "INVALID"]]));
});
