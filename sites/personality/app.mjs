import { compare, connections, dimensions, groups, profileClusters, readProfiles } from "./model.mjs";

const element = id => document.getElementById(id);
const svgNamespace = "http://www.w3.org/2000/svg";
const width = 960;
const height = 600;
const includeIdentity = true;
const axisCount = dimensions.length;
const pluralRules = new Intl.PluralRules("ru");
const participantForms = { one: "участник", few: "участника", many: "участников" };

function node(tag, text = "", className = "") {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}

function countLabel(count, forms) {
  return `${count} ${forms[pluralRules.select(count)] ?? forms.many}`;
}

function circlePoint(index, count, x, y, radiusX, radiusY) {
  const angle = -Math.PI / 2 + index * 2 * Math.PI / count;
  return { x: x + Math.cos(angle) * radiusX, y: y + Math.sin(angle) * radiusY };
}

function packRows(items, columns, columnGap, rowGap) {
  if (!items.length) return { width: 0, height: 0, positions: [] };
  const rows = [];
  for (let start = 0; start < items.length; start += columns) {
    const cells = items.slice(start, start + columns);
    rows.push({
      cells,
      width: cells.reduce((sum, cell) => sum + 2 * cell.rx, columnGap * (cells.length - 1)),
      height: Math.max(...cells.map(cell => 2 * cell.ry)),
    });
  }
  const packedWidth = Math.max(...rows.map(row => row.width));
  let top = 0;
  const positions = rows.flatMap(row => {
    let left = (packedWidth - row.width) / 2;
    const y = top + row.height / 2;
    top += row.height + rowGap;
    return row.cells.map(cell => {
      const x = left + cell.rx;
      left += 2 * cell.rx + columnGap;
      return [cell.id, { x, y }];
    });
  });
  return { width: packedWidth, height: top - rowGap, positions };
}

function layoutTeam(views) {
  const gap = 38;
  const blocks = groups.map(group => {
    const members = [...views.values()]
      .filter(view => view.cluster.group === group.id)
      .map(({ cluster, rx, ry }) => ({ id: cluster.id, rx, ry }));
    return packRows(members, Math.ceil(Math.sqrt(members.length)), 24, 26);
  });
  const columnWidths = [Math.max(blocks[0].width, blocks[2].width), Math.max(blocks[1].width, blocks[3].width)];
  const rowHeights = [Math.max(blocks[0].height, blocks[1].height), Math.max(blocks[2].height, blocks[3].height)];
  return new Map(blocks.flatMap((block, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const left = (columnWidths[column] - block.width) / 2 + (column ? columnWidths[0] + gap : 0);
    const top = (rowHeights[row] - block.height) / 2 + (row ? rowHeights[0] + gap : 0);
    return block.positions.map(([id, point]) => [id, { x: left + point.x, y: top + point.y }]);
  }));
}

function start(people) {
  const byId = new Map(people.map(person => [person.id, person]));
  const alphabetical = [...people].sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const byType = [...alphabetical].sort((a, b) => a.code.localeCompare(b.code));
  const state = {
    first: people[0].id,
    second: people[Math.min(2, people.length - 1)].id,
    view: "graph",
    scope: "team",
    threshold: 3,
    order: "name",
  };
  const first = element("first");
  const second = element("second");
  const graph = element("graph-panel");
  const stage = element("graph-stage");
  const world = element("graph-world");
  const edges = element("edges");
  const graphNodes = element("graph-nodes");
  const matrixPanel = element("matrix-panel");
  const matrix = element("matrix");
  const threshold = element("threshold");
  const viewButtons = [...document.querySelectorAll("[data-view]")];
  let matrixState = null;
  let graphState = null;
  let fitted = false;
  let camera = { x: 0, y: 0, scale: 1 };

  for (const person of alphabetical) {
    for (const select of [first, second]) {
      const option = node("option", `${person.name} · ${person.code}`);
      option.value = person.id;
      select.append(option);
    }
  }
  for (const group of groups) {
    const count = people.filter(person => person.group === group.id).length;
    if (!count) continue;
    const legend = node("span", `${group.label} · ${count}`);
    legend.dataset.group = group.id;
    element("graph-legend").append(legend);
  }
  element("coverage").textContent = [
    countLabel(people.length, participantForms),
    countLabel(people.length * (people.length - 1) / 2, { one: "пара", few: "пары", many: "пар" }),
  ].join(" · ");
  element("scope").value = state.scope;

  function renderPair() {
    const a = byId.get(state.first);
    const b = byId.get(state.second);
    first.value = a.id;
    second.value = b.id;
    for (const option of first.options) option.disabled = Number(option.value) === b.id;
    for (const option of second.options) option.disabled = Number(option.value) === a.id;

    const { score, total, axes } = compare(a, b, includeIdentity);
    const name = node("p", `${a.name} × ${b.name}`, "pair-name");
    const codes = node("p", `${a.code} / ${b.code}`, "pair-codes");
    const tally = node("p", `${score} из ${total} `, "pair-score");
    tally.append(node("small", "совпали"));
    const breakdown = node("dl", "", "axes");
    for (const axis of axes) {
      const equal = axis.first === axis.second;
      const row = node("div", "", equal ? "match" : "");
      row.append(node("dt", axis.label), node("dd", equal ? `${axis.first} · совпало` : `${axis.first} / ${axis.second}`));
      breakdown.append(row);
    }
    element("pair-details").replaceChildren(name, codes, tally, breakdown);
  }

  function applyCamera() {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
  }

  let bounds = { minX: 0, minY: 0, maxX: width, maxY: height };
  function fit() {
    if (graph.hidden || !stage.clientWidth || !stage.clientHeight) return;
    const scale = Math.min(
      (stage.clientWidth - 18) / (bounds.maxX - bounds.minX),
      (stage.clientHeight - 34) / (bounds.maxY - bounds.minY),
      1.4,
    );
    camera = {
      x: stage.clientWidth / 2 - scale * (bounds.minX + bounds.maxX) / 2,
      y: stage.clientHeight / 2 - scale * (bounds.minY + bounds.maxY) / 2,
      scale,
    };
    fitted = true;
    applyCamera();
  }

  function zoom(factor) {
    const x = stage.clientWidth / 2;
    const y = stage.clientHeight / 2;
    const scale = Math.max(.22, Math.min(2.8, camera.scale * factor));
    const ratio = scale / camera.scale;
    camera = { x: x - (x - camera.x) * ratio, y: y - (y - camera.y) * ratio, scale };
    fitted = false;
    applyCamera();
  }

  function buildGraph() {
    const clusters = profileClusters(alphabetical, includeIdentity);
    const byMember = new Map();
    const buttons = new Map(alphabetical.map(person => {
      const button = node("button", person.name, "graph-node");
      button.type = "button";
      button.dataset.group = person.group;
      button.dataset.person = person.id;
      button.title = `${person.name} · ${person.code}`;
      button.setAttribute("aria-label", button.title);
      return [person.id, button];
    }));
    graphNodes.replaceChildren(...buttons.values());
    const sizes = new Map([...buttons].map(([id, button]) => [id, {
      id,
      rx: button.offsetWidth / 2,
      ry: button.offsetHeight / 2,
    }]));
    const views = new Map();
    for (const cluster of clusters) {
      const members = cluster.members.map(person => sizes.get(person.id));
      for (const { id } of members) byMember.set(id, cluster.id);
      let { rx, ry } = members[0];
      let shape = buttons.get(cluster.id);
      if (members.length > 1) {
        const packed = packRows(members, Math.round(Math.sqrt(members.length)), 8, 7);
        const centerX = packed.width / 2;
        const centerY = packed.height / 2;
        ry = centerY + 20;
        // Enclose the outer corners of each name's box, including a small gap.
        rx = Math.ceil(Math.max(...packed.positions.map(([id, point]) => {
          const member = sizes.get(id);
          const x = Math.abs(point.x - centerX) + member.rx + 8;
          const y = (Math.abs(point.y - centerY) + member.ry + 4) / ry;
          return x / Math.sqrt(1 - y * y);
        })));
        shape = node("div", "", "graph-cluster");
        shape.dataset.group = cluster.group;
        shape.setAttribute("role", "group");
        shape.setAttribute("aria-label", `${cluster.code} · ${countLabel(cluster.members.length, participantForms)}`);
        shape.style.width = `${2 * rx}px`;
        shape.style.height = `${2 * ry}px`;
        for (const [id, point] of packed.positions) {
          const button = buttons.get(id);
          button.style.left = `${rx + point.x - centerX}px`;
          button.style.top = `${ry + point.y - centerY}px`;
          shape.append(button);
        }
        shape.append(node("span", cluster.code, "cluster-label"));
      }
      views.set(cluster.id, { cluster, shape, rx, ry });
    }
    graphNodes.replaceChildren(...[...views.values()].map(view => view.shape));
    graphState = {
      representatives: clusters.map(cluster => cluster.members[0]),
      byMember,
      buttons,
      views,
      teamPositions: layoutTeam(views),
    };
  }

  function personLayout(graphEdges, focus, views) {
    const positions = new Map([[focus, { x: width / 2, y: height / 2 }]]);
    const outerRadius = id => Math.max(views.get(id).rx, views.get(id).ry);
    let occupiedRadius = outerRadius(focus);
    for (let score = axisCount; score >= state.threshold; score--) {
      const neighbors = graphEdges.filter(edge => edge.score === score)
        .map(edge => edge.from === focus ? edge.to : edge.from);
      if (!neighbors.length) continue;
      const largest = Math.max(...neighbors.map(outerRadius));
      const spacing = neighbors.length > 1 ? (largest + 16) / Math.sin(Math.PI / neighbors.length) : 0;
      const orbit = Math.max(occupiedRadius + largest + 38, spacing);
      for (const [index, id] of neighbors.entries()) {
        positions.set(id, circlePoint(index, neighbors.length, width / 2, height / 2, orbit, orbit));
      }
      occupiedRadius = orbit + largest;
    }
    return positions;
  }

  function renderGraph(refit = false) {
    if (!graphState) buildGraph();
    const { representatives, byMember, buttons, views, teamPositions } = graphState;
    const firstNode = byMember.get(state.first);
    const secondNode = byMember.get(state.second);
    const focus = state.scope === "person" ? firstNode : null;
    const visibleEdges = connections(representatives, includeIdentity, state.threshold, focus);
    const positions = focus === null ? teamPositions : personLayout(visibleEdges, focus, views);
    const points = [...positions].map(([id, point]) => {
      const { rx, ry } = views.get(id);
      return { ...point, rx, ry };
    });
    bounds = {
      minX: Math.min(...points.map(point => point.x - point.rx)) - 24,
      maxX: Math.max(...points.map(point => point.x + point.rx)) + 24,
      minY: Math.min(...points.map(point => point.y - point.ry)) - 12,
      maxY: Math.max(...points.map(point => point.y + point.ry)) + 31,
    };
    for (const [id, { shape }] of views) {
      const point = positions.get(id);
      shape.hidden = !point;
      if (!point) continue;
      shape.style.left = `${point.x}px`;
      shape.style.top = `${point.y}px`;
    }
    for (const [id, button] of buttons) {
      button.classList.toggle("first", id === state.first);
      button.classList.toggle("second", id === state.second);
      button.setAttribute("aria-pressed", String(id === state.second));
    }
    const lines = visibleEdges.map(edge => {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      const pair = [edge.from, edge.to];
      const selected = firstNode !== secondNode && pair.includes(firstNode) && pair.includes(secondNode);
      const focused = pair.includes(firstNode);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const a = views.get(edge.from);
      const b = views.get(edge.to);
      const fromOffset = 1 / Math.hypot(dx / a.rx, dy / a.ry);
      const toOffset = 1 / Math.hypot(dx / b.rx, dy / b.ry);
      const line = document.createElementNS(svgNamespace, "line");
      for (const [key, value] of Object.entries({
        x1: from.x + dx * fromOffset,
        y1: from.y + dy * fromOffset,
        x2: to.x - dx * toOffset,
        y2: to.y - dy * toOffset,
      })) line.setAttribute(key, value);
      line.setAttribute("class", ["edge", edge.score === edge.total - 1 ? "strong" : "", focused ? "focused" : "", selected ? "selected" : ""].join(" "));
      return line;
    });
    edges.replaceChildren(...lines);
    element("graph-status").textContent = [
      focus === null ? "" : byId.get(state.first).name,
      countLabel([...positions.keys()].reduce((count, id) => count + views.get(id).cluster.members.length, 0), participantForms),
      countLabel(visibleEdges.length, { one: "связь", few: "связи", many: "связей" }),
      `от ${state.threshold} из ${axisCount}`,
    ].filter(Boolean).join(" · ");
    if (refit || fitted) fit();
  }

  const ordered = () => state.order === "type" ? byType : alphabetical;
  function buildMatrix() {
    const rows = ordered();
    const head = node("thead");
    const heading = node("tr");
    const corner = node("th", "Участники");
    corner.scope = "col";
    heading.append(corner);
    const columns = new Map();
    const rowHeaders = new Map();
    const cells = new Map();
    for (const person of rows) {
      const column = node("th");
      column.scope = "col";
      column.append(node("span", person.name));
      columns.set(person.id, column);
      heading.append(column);
    }
    head.append(heading);
    const body = node("tbody");
    for (const [i, person] of rows.entries()) {
      const row = node("tr");
      const header = node("th", person.name);
      header.scope = "row";
      rowHeaders.set(person.id, header);
      row.append(header);
      for (const [j, counterpart] of rows.entries()) {
        const cell = node("td", i === j ? "—" : "");
        if (i !== j) {
          const { score, total } = compare(person, counterpart, includeIdentity);
          const button = node("button", score, "matrix-cell");
          button.type = "button";
          button.tabIndex = -1;
          button.dataset.row = i;
          button.dataset.column = j;
          button.dataset.score = score;
          button.title = `${person.name} × ${counterpart.name} · ${score} из ${total}`;
          button.setAttribute("aria-label", button.title);
          cells.set(`${person.id}/${counterpart.id}`, button);
          cell.append(button);
        }
        row.append(cell);
      }
      body.append(row);
    }
    matrix.replaceChildren(head, body);
    const key = Array.from({ length: axisCount + 1 }, (_, value) => {
      const swatch = node("span", value);
      swatch.dataset.score = value;
      return swatch;
    });
    element("matrix-key").replaceChildren(...key);
    matrixState = { order: state.order, columns, rowHeaders, cells, selected: null };
  }

  function renderMatrix() {
    if (!matrixState || matrixState.order !== state.order) buildMatrix();
    const { selected, columns, rowHeaders, cells } = matrixState;
    if (selected) {
      rowHeaders.get(selected[0]).removeAttribute("data-selected");
      columns.get(selected[1]).removeAttribute("data-selected");
      const old = cells.get(selected.join("/"));
      old.removeAttribute("aria-current");
      old.tabIndex = -1;
    }
    rowHeaders.get(state.first).dataset.selected = "true";
    columns.get(state.second).dataset.selected = "true";
    const current = cells.get(`${state.first}/${state.second}`);
    current.setAttribute("aria-current", "true");
    current.tabIndex = 0;
    matrixState.selected = [state.first, state.second];
  }

  function setPair(a, b) {
    if (a === b || !byId.has(a) || !byId.has(b)) return;
    const focusChanged = state.first !== a && state.scope === "person";
    state.first = a;
    state.second = b;
    renderPair();
    if (state.view === "graph") renderGraph(focusChanged);
    else renderMatrix();
  }

  function setView(view) {
    state.view = view;
    graph.hidden = view !== "graph";
    matrixPanel.hidden = view !== "matrix";
    for (const button of viewButtons) button.setAttribute("aria-pressed", String(button.dataset.view === view));
    if (view === "graph") renderGraph(true);
    else renderMatrix();
  }

  threshold.replaceChildren(...Array.from({ length: axisCount }, (_, i) => {
    const option = node("option", `${i + 1} из ${axisCount}`);
    option.value = i + 1;
    return option;
  }));
  threshold.value = state.threshold;
  first.addEventListener("change", () => setPair(Number(first.value), state.second));
  second.addEventListener("change", () => setPair(state.first, Number(second.value)));
  for (const button of viewButtons) button.addEventListener("click", () => setView(button.dataset.view));
  element("scope").addEventListener("change", event => {
    state.scope = event.target.value;
    renderGraph(true);
  });
  threshold.addEventListener("change", event => {
    state.threshold = Number(event.target.value);
    renderGraph(state.scope === "person");
  });
  element("matrix-order").addEventListener("change", event => {
    state.order = event.target.value;
    renderMatrix();
  });
  element("focus-second").addEventListener("click", () => {
    state.scope = "person";
    element("scope").value = state.scope;
    setPair(state.second, state.first);
    setView("graph");
  });
  graphNodes.addEventListener("click", event => {
    const button = event.target.closest("button[data-person]");
    if (button) setPair(state.first, Number(button.dataset.person));
  });
  matrix.addEventListener("click", event => {
    const button = event.target.closest("button[data-row]");
    if (!button) return;
    const rows = ordered();
    setPair(rows[button.dataset.row].id, rows[button.dataset.column].id);
  });
  matrix.addEventListener("keydown", event => {
    const directions = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const step = directions[event.key];
    const cell = event.target.closest("button[data-row]");
    if (!step || !cell) return;
    event.preventDefault();
    const rows = ordered();
    let row = Number(cell.dataset.row) + step[0];
    let column = Number(cell.dataset.column) + step[1];
    if (row === column) {
      row += step[0];
      column += step[1];
    }
    if (!rows[row] || !rows[column]) return;
    matrixState.cells.get(`${rows[row].id}/${rows[column].id}`).focus();
  });
  element("zoom-in").addEventListener("click", () => zoom(1.25));
  element("zoom-out").addEventListener("click", () => zoom(.8));
  element("zoom-reset").addEventListener("click", fit);
  let drag = null;
  stage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.target.closest("button")) return;
    drag = { id: event.pointerId, x: event.clientX - camera.x, y: event.clientY - camera.y };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("dragging");
  });
  stage.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    camera.x = event.clientX - drag.x;
    camera.y = event.clientY - drag.y;
    fitted = false;
    applyCamera();
  });
  stage.addEventListener("lostpointercapture", () => {
    drag = null;
    stage.classList.remove("dragging");
  });
  new ResizeObserver(() => { if (fitted) fit(); }).observe(stage);
  element("workspace").hidden = false;
  renderPair();
  setView("graph");
}

try {
  const response = await fetch("./profiles.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Profiles unavailable");
  start(readProfiles(await response.json()));
} catch (error) {
  element("coverage").textContent = "";
  const message = element("load-error");
  message.hidden = false;
  message.textContent = "Не удалось загрузить результаты теста. Обнови страницу или обратись к владельцу сайта.";
  console.error(error);
}
