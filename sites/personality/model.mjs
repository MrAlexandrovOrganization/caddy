export const dimensions = [
  { index: 0, label: "Энергия", pole: "E" },
  { index: 1, label: "Разум", pole: "N" },
  { index: 2, label: "Природа", pole: "T" },
  { index: 3, label: "Тактика", pole: "J" },
  { index: 5, label: "Идентичность (A/T)", pole: "A" },
];
const fullMask = 2 ** dimensions.length - 1;

export const groups = [
  { id: "diplomats", label: "Дипломаты" },
  { id: "analysts", label: "Аналитики" },
  { id: "sentinels", label: "Стражи" },
  { id: "explorers", label: "Искатели" },
  { id: "unreported", label: "Без результата теста" },
];

export function readProfiles(records) {
  if (!Array.isArray(records) || records.length < 2) throw new Error("Ожидается список из двух или более профилей.");
  const names = new Set();
  return records.map((record, id) => {
    if (!Array.isArray(record) || record.length !== 2) throw new Error("Некорректная строка профиля.");
    const [name, code] = record;
    if (typeof name !== "string" || !name.trim() || names.has(name.trim()) ||
        (code !== null && (typeof code !== "string" || !/^[EI][NS][TF][JP]-[AT]$/.test(code)))) {
      throw new Error("В списке есть некорректный или повторяющийся профиль.");
    }
    names.add(name.trim());
    const group = code === null ? "unreported" : code[1] === "N"
      ? (code[2] === "F" ? "diplomats" : "analysts")
      : (code[3] === "J" ? "sentinels" : "explorers");
    return { id, name: name.trim(), code, group };
  });
}

const pairKey = (first, second) => first < second ? `${first}/${second}` : `${second}/${first}`;

export function readSnapshot(snapshot) {
  const people = readProfiles(Array.isArray(snapshot) ? snapshot : snapshot?.profiles);
  const measurements = new Map();
  const measuredIds = new Set();
  const correlationIds = new Set();
  let correlationCount = 0;
  for (const [first, second, score, mask, correlation = null] of snapshot.measurements ?? []) {
    const key = pairKey(first, second);
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 ||
        first >= second || second >= people.length || !people[first].code || !people[second].code ||
        measurements.has(key) ||
        !Number.isFinite(score) || score < 0 || score > 100 ||
        !Number.isInteger(mask) || mask < 1 || mask > fullMask ||
        (correlation !== null && (mask !== fullMask || !Number.isFinite(correlation) || Math.abs(correlation) > 1))) {
      throw new Error("Некорректные данные сравнения.");
    }
    measurements.set(key, { score, mask, correlation });
    measuredIds.add(first);
    measuredIds.add(second);
    if (correlation !== null) {
      correlationIds.add(first);
      correlationIds.add(second);
      correlationCount++;
    }
  }
  return { people, measurements, measuredIds, correlationIds, correlationCount };
}

function pearson(first, second) {
  const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanA = average(first);
  const meanB = average(second);
  let cross = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i] - meanA;
    const b = second[i] - meanB;
    cross += a * b;
    sumA += a * a;
    sumB += b * b;
  }
  if (!sumA || !sumB) return null;
  return Math.max(-1, Math.min(1, cross / Math.sqrt(sumA * sumB)));
}

export function buildSnapshot(rows) {
  const profiles = rows.map(([name, code]) => [name, code]);
  const people = readProfiles(profiles);
  const percentages = rows.map(([, code, values]) => {
    if (!Array.isArray(values) || values.length !== dimensions.length ||
        values.some(value => value !== null && (code === null || !Number.isFinite(value) || value < 50 || value > 100))) {
      throw new Error("Ожидаются проценты ведущих букв или пустые значения по пяти шкалам.");
    }
    return values.map((value, position) => {
      const { index, pole } = dimensions[position];
      if (value === null || code[index] === pole) return value;
      return 100 - value;
    });
  });
  const measurements = [];
  const reported = people.filter(person => person.code !== null);
  for (const [i, first] of reported.entries()) {
    for (const second of reported.slice(i + 1)) {
      let distance = 0;
      let mask = 0;
      for (const [position, { index }] of dimensions.entries()) {
        const a = percentages[first.id][position];
        const b = percentages[second.id][position];
        if (a !== null && b !== null) {
          mask |= 1 << position;
          distance += Math.abs(a - b);
        } else if (first.code[index] !== second.code[index]) {
          distance += 100;
        }
      }
      if (!mask) continue;
      const score = (100 * dimensions.length - distance) / dimensions.length;
      const measurement = [first.id, second.id, score, mask];
      if (mask === fullMask) measurement.push(pearson(percentages[first.id], percentages[second.id]));
      measurements.push(measurement);
    }
  }
  return { profiles, measurements };
}

export function compare(first, second, measurements) {
  if (first.code === null || second.code === null) return { axes: [], matches: null, measured: 0, score: null, correlation: null };
  const data = measurements.get(pairKey(first.id, second.id));
  const axes = dimensions.map(({ index, label }, position) => ({
    label,
    first: first.code[index],
    second: second.code[index],
    measured: Boolean((data?.mask ?? 0) & (1 << position)),
  }));
  const matches = axes.filter(axis => axis.first === axis.second).length;
  const measured = axes.filter(axis => axis.measured).length;
  return { axes, matches, measured, score: data?.score ?? matches * 100 / axes.length, correlation: data?.correlation ?? null };
}

export function profileClusters(people) {
  const clusters = new Map();
  for (const person of people) {
    const { code } = person;
    const key = code ?? person.id;
    if (!clusters.has(key)) clusters.set(key, { id: person.id, code, group: person.group, members: [] });
    clusters.get(key).members.push(person);
  }
  return [...clusters.values()];
}

export function connections(clusters, measurements, minimum, focusId = null, measuredOnly = false) {
  const edges = [];
  const reported = clusters.filter(cluster => cluster.code !== null);
  for (const [index, from] of reported.entries()) {
    for (const to of reported.slice(index + 1)) {
      let best = null;
      for (const first of from.members) {
        for (const second of to.members) {
          if (focusId !== null && first.id !== focusId && second.id !== focusId) continue;
          const { score, measured } = compare(first, second, measurements);
          if (!best || measured > best.measured || (measured === best.measured && score > best.score)) {
            best = { from: from.id, to: to.id, first: first.id, second: second.id, score, measured };
          }
        }
      }
      if (best && best.score >= minimum && (!measuredOnly || best.measured > 0)) edges.push(best);
    }
  }
  return edges;
}
