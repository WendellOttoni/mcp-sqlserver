function addEdge(adjacency, from, to, payload) {
  if (!adjacency.has(from)) {
    adjacency.set(from, []);
  }
  adjacency.get(from).push({ to, ...payload });
}

export function buildRelationshipGraph(tables) {
  const adjacency = new Map();

  for (const table of tables) {
    if (!adjacency.has(table.normalizedFullName)) {
      adjacency.set(table.normalizedFullName, []);
    }

    for (const fk of table.foreignKeys) {
      const from = table.normalizedFullName;
      const to = `${fk.toSchema}.${fk.toTable}`.toLowerCase();

      addEdge(adjacency, from, to, {
        type: "outbound",
        fromColumn: fk.fromColumn,
        toColumn: fk.toColumn,
        constraintName: fk.constraintName,
      });
      addEdge(adjacency, to, from, {
        type: "inbound",
        fromColumn: fk.toColumn,
        toColumn: fk.fromColumn,
        constraintName: fk.constraintName,
      });
    }
  }

  return { adjacency };
}

export function computeCentrality(graph) {
  const centrality = new Map();

  for (const [node, edges] of graph.adjacency.entries()) {
    centrality.set(node, edges.length);
  }

  return centrality;
}

export function shortestJoinPath(graph, from, to) {
  if (from === to) {
    return [{ table: from }];
  }

  const queue = [[from]];
  let head = 0;
  const visited = new Set([from]);

  while (head < queue.length) {
    const path = queue[head];
    head += 1;
    const current = path[path.length - 1];
    const currentNode = typeof current === "string" ? current : current.table;
    const edges = graph.adjacency.get(currentNode) || [];

    for (const edge of edges) {
      if (visited.has(edge.to)) {
        continue;
      }

      const nextPath = [
        ...path,
        {
          table: edge.to,
          via: {
            fromTable: currentNode,
            toTable: edge.to,
            fromColumn: edge.fromColumn,
            toColumn: edge.toColumn,
            type: edge.type,
            constraintName: edge.constraintName,
          },
        },
      ];

      if (edge.to === to) {
        return nextPath;
      }

      visited.add(edge.to);
      queue.push(nextPath);
    }
  }

  return null;
}
