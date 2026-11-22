export const dimensions = [
  { index: 0, label: "Энергия" },
  { index: 1, label: "Разум" },
  { index: 2, label: "Природа" },
  { index: 3, label: "Тактика" },
  { index: 5, label: "Идентичность (A/T)" },
];

export const groups = [
  { id: "diplomats", label: "Дипломаты" },
  { id: "analysts", label: "Аналитики" },
  { id: "sentinels", label: "Стражи" },
  { id: "explorers", label: "Искатели" },
];

export function readProfiles(records) {
  if (!Array.isArray(records) || records.length < 2) throw new Error("Ожидается список из двух или более профилей.");
  const names = new Set();
  return records.map((record, id) => {
    if (!Array.isArray(record) || record.length !== 2) throw new Error("Некорректная строка профиля.");
    const [name, code] = record;
    if (typeof name !== "string" || !name.trim() || names.has(name.trim()) ||
        typeof code !== "string" || !/^[EI][NS][TF][JP]-[AT]$/.test(code)) {
      throw new Error("В списке есть некорректный или повторяющийся профиль.");
    }
    names.add(name.trim());
    const group = code[1] === "N"
      ? (code[2] === "F" ? "diplomats" : "analysts")
      : (code[3] === "J" ? "sentinels" : "explorers");
    return { id, name: name.trim(), code, group };
  });
}

const pairKey = (first, second) => first < second ? `${first}/${second}` : `${second}/${first}`;

export function readSnapshot(snapshot) {
  const people = readProfiles(Array.isArray(snapshot) ? snapshot : snapshot?.profiles);
  const measurements = new Map();
  for (const [first, second, score, mask] of snapshot.measurements ?? []) {
    const key = pairKey(first, second);
    if (!Number.isInteger(first) || !Number.isInteger(second) || first < 0 ||
        first >= second || second >= people.length || measurements.has(key) ||
        !Number.isFinite(score) || score < 0 || score > 100 ||
        !Number.isInteger(mask) || mask < 1 || mask >= 2 ** dimensions.length) {
      throw new Error("Некорректные данные сравнения.");
    }
    measurements.set(key, { score, mask });
  }
  return { people, measurements };
}

export function buildSnapshot(rows) {
  const profiles = rows.map(([name, code]) => [name, code]);
  const people = readProfiles(profiles);
  const percentages = rows.map(([, , values]) => {
    if (!Array.isArray(values) || values.length !== dimensions.length ||
        values.some(value => value !== null && (!Number.isInteger(value) || value < 50 || value > 100))) {
      throw new Error("Ожидаются проценты ведущих букв или пустые значения по пяти шкалам.");
    }
    return values;
  });
  const measurements = [];
  for (const first of people) {
    for (const second of people.slice(first.id + 1)) {
      let distance = 0;
      let mask = 0;
      for (const [position, { index }] of dimensions.entries()) {
        const a = percentages[first.id][position];
        const b = percentages[second.id][position];
        const samePole = first.code[index] === second.code[index];
        if (a !== null && b !== null) {
          mask |= 1 << position;
          distance += samePole ? Math.abs(a - b) : a + b - 100;
        } else if (!samePole) {
          distance += 100;
        }
      }
      if (mask) measurements.push([first.id, second.id, (100 * dimensions.length - distance) / dimensions.length, mask]);
    }
  }
  return { profiles, measurements };
}

export function compare(first, second, measurements) {
  const data = measurements.get(pairKey(first.id, second.id));
  const axes = dimensions.map(({ index, label }, position) => ({
    label,
    first: first.code[index],
    second: second.code[index],
    measured: Boolean((data?.mask ?? 0) & (1 << position)),
  }));
  const matches = axes.filter(axis => axis.first === axis.second).length;
  const measured = axes.filter(axis => axis.measured).length;
  return { axes, matches, measured, score: data?.score ?? matches * 100 / axes.length };
}

export function profileClusters(people) {
  const clusters = new Map();
  for (const person of people) {
    const { code } = person;
    if (!clusters.has(code)) clusters.set(code, { id: person.id, code, group: person.group, members: [] });
    clusters.get(code).members.push(person);
  }
  return [...clusters.values()];
}

export function connections(clusters, measurements, minimum, focusId = null, measuredOnly = false) {
  const edges = [];
  for (const [index, from] of clusters.entries()) {
    for (const to of clusters.slice(index + 1)) {
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
