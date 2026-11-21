export const dimensions = [
  { index: 0, label: "Энергия" },
  { index: 1, label: "Восприятие" },
  { index: 2, label: "Решения" },
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

export function compare(first, second, includeIdentity) {
  const axes = dimensions.map(({ index, label }) => ({
    label,
    first: first.code[index],
    second: second.code[index],
    counted: index !== 5 || includeIdentity,
  }));
  const counted = axes.filter(axis => axis.counted);
  return { axes, total: counted.length, score: counted.filter(axis => axis.first === axis.second).length };
}

export function profileClusters(people, includeIdentity) {
  const clusters = new Map();
  for (const person of people) {
    const code = includeIdentity ? person.code : person.code.slice(0, 4);
    if (!clusters.has(code)) clusters.set(code, { id: person.id, code, group: person.group, members: [] });
    clusters.get(code).members.push(person);
  }
  return [...clusters.values()];
}

export function connections(people, includeIdentity, minimum, focusId = null) {
  const edges = [];
  for (const [index, first] of people.entries()) {
    for (const second of people.slice(index + 1)) {
      if (focusId !== null && first.id !== focusId && second.id !== focusId) continue;
      const { score, total } = compare(first, second, includeIdentity);
      if (score >= minimum) edges.push({ from: first.id, to: second.id, score, total });
    }
  }
  return edges;
}
