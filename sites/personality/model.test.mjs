import assert from "node:assert/strict";
import test from "node:test";
import { buildSnapshot, compare, connections, profileClusters, readProfiles, readSnapshot } from "./model.mjs";

const legacy = [["А", "ENFJ-A"], ["Б", "ENFJ-T"], ["В", "INFJ-A"], ["Г", "ISTP-T"]];

test("letter comparisons use all five axes, including A/T", () => {
  const { people: [first, second, third], measurements } = readSnapshot(legacy);
  const pair = compare(first, second, measurements);
  assert.deepEqual([pair.score, pair.matches, pair.measured], [80, 4, 0]);
  assert.deepEqual(pair.axes.at(-1), {
    label: "Идентичность (A/T)", first: "A", second: "T", measured: false,
  });
  assert.equal(compare(first, third, measurements).score, 80);
});

test("numeric comparisons use a common scale for opposite poles and handle partial coverage", () => {
  const snapshot = buildSnapshot([
    ["А", "ENFJ-A", [51, 60, 70, 50, 100]],
    ["Б", "INFJ-T", [51, 60, 75, 50, 100]],
    ["В", "INFJ-A", [51, null, null, null, null]],
    ["Г", "ENFJ-T", [null, null, null, null, null]],
  ]);
  assert.deepEqual(snapshot.profiles, [["А", "ENFJ-A"], ["Б", "INFJ-T"], ["В", "INFJ-A"], ["Г", "ENFJ-T"]]);
  assert.deepEqual(snapshot.measurements, [[0, 1, 78.6, 31], [0, 2, 99.6, 1], [1, 2, 80, 1]]);
  const { people: [first, second, third, fourth], measurements } = readSnapshot(snapshot);
  const forward = compare(first, second, measurements);
  const reverse = compare(second, first, measurements);
  assert.deepEqual([forward.score, forward.matches, forward.measured], [78.6, 3, 5]);
  assert.deepEqual(reverse.axes.map(axis => [axis.second, axis.first]), forward.axes.map(axis => [axis.first, axis.second]));
  assert.equal(reverse.score, forward.score);
  assert.deepEqual(compare(first, third, measurements).axes.map(axis => axis.measured), [true, false, false, false, false]);
  assert.equal(compare(first, fourth, measurements).score, 80);
});

test("clusters keep identical types together and choose the best-evidenced pair", () => {
  const { people, measurements } = readSnapshot(buildSnapshot([
    ["А", "ENFJ-A", [null, null, null, null, null]],
    ["Б", "ENFJ-A", [100, 100, 100, 100, 100]],
    ["В", "INFJ-A", [100, 51, 51, 51, 51]],
    ["Г", "INFJ-T", [null, null, null, null, null]],
  ]));
  const clusters = profileClusters(people);
  assert.deepEqual(clusters.map(({ members }) => members.map(person => person.id)), [[0, 1], [2], [3]]);
  const measuredEdge = { from: 0, to: 2, first: 1, second: 2, score: 40.8, measured: 5 };
  assert.deepEqual(connections(clusters, measurements, 40, null, true), [measuredEdge]);
  assert.deepEqual(connections(clusters, measurements, 80), [{ from: 2, to: 3, first: 2, second: 3, score: 80, measured: 0 }]);
  assert.deepEqual(connections(clusters, measurements, 80, 0), [{ from: 0, to: 2, first: 0, second: 2, score: 80, measured: 0 }]);
  assert.deepEqual(connections(clusters, measurements, 40, 0, true), []);
});

test("missing, duplicate and malformed rows and measurements fail validation", () => {
  assert.throws(() => readProfiles([]));
  assert.throws(() => readProfiles([["А", "ENFJ-A"], [" А ", "INTJ-T"]]));
  assert.throws(() => readProfiles([["А", "ENFJ-A"], ["Б", "INVALID"]]));
  assert.throws(() => readSnapshot({ profiles: legacy, measurements: [[0, 1, 90, 32]] }));
  assert.throws(() => buildSnapshot([["А", "ENFJ-A", [49, 50, 50, 50, 50]], ["Б", "ENFJ-T", [60, 60, 60, 60, 60]]]));
});
