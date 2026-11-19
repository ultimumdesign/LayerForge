const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function patchChanges(before, after) {
  const changes = [];
  const collect = (path, oldSection, newSection) => {
    for (const key of Object.keys(oldSection)) {
      if (!sameValue(oldSection[key], newSection[key])) {
        changes.push({ path: [...path, key], before: oldSection[key], after: newSection[key] });
      }
    }
  };
  before.layers.forEach((layer, index) => collect(['layers', index], layer, after.layers[index]));
  collect(['noise'], before.noise, after.noise);
  collect(['master'], before.master, after.master);
  return changes;
}

function setPath(state, path, value) {
  if (path[0] === 'layers') {
    return {
      ...state,
      layers: state.layers.map((layer, index) =>
        index === path[1] ? { ...layer, [path[2]]: value } : layer)
    };
  }
  return { ...state, [path[0]]: { ...state[path[0]], [path[1]]: value } };
}

export function createPatchHistory(limit = 100) {
  let past = [];
  let future = [];
  return {
    clear() {
      past = [];
      future = [];
    },
    record(before, after, group = null) {
      const changes = patchChanges(before, after);
      if (!changes.length) return;
      future = [];
      const entry = group !== null && past.at(-1)?.group === group ? past.at(-1) : null;
      if (entry) {
        for (const change of changes) {
          const previous = entry.changes.find((item) => sameValue(item.path, change.path));
          if (previous) previous.after = change.after;
          else entry.changes.push(change);
        }
        entry.changes = entry.changes.filter((change) => !sameValue(change.before, change.after));
        if (!entry.changes.length) past.pop();
      } else {
        past.push({ group, changes });
        if (past.length > limit) past.shift();
      }
    },
    invalidate(path) {
      const filter = (entries) => entries.map((entry) => ({
        ...entry,
        changes: entry.changes.filter((change) => !sameValue(change.path, path))
      })).filter((entry) => entry.changes.length);
      past = filter(past);
      future = filter(future);
    },
    undo(state) {
      const entry = past.pop();
      if (!entry) return null;
      future.push(entry);
      return entry.changes.reduce((result, change) => setPath(result, change.path, change.before), state);
    },
    redo(state) {
      const entry = future.pop();
      if (!entry) return null;
      past.push(entry);
      return entry.changes.reduce((result, change) => setPath(result, change.path, change.after), state);
    }
  };
}

export function getHistoryShortcut(event) {
  const target = event.target;
  if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey) ||
      (event.metaKey && event.ctrlKey) || target?.isContentEditable ||
      (target?.tagName === 'INPUT' && target.type !== 'range') ||
      target?.tagName === 'TEXTAREA') return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.shiftKey) return 'redo';
  return null;
}
