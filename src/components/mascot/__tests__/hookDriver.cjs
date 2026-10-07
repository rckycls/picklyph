// Deterministic hook runner for lifecycle checks; it does not render a native or web preview.
module.exports = function hookDriver() {
  const slots = []; let index = 0; let dirty = true; let result; let render;
  const pending = new Map();
  const same = (a, b) => a?.length === b.length && b.every((v, i) => Object.is(v, a[i]));
  const react = {
    useState(initial) {
      const at = index++;
      if (!slots[at]) {
        const slot = { value: typeof initial === 'function' ? initial() : initial };
        slot.set = next => { const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(slot.value, value)) { slot.value = value; dirty = true; } };
        slots[at] = slot;
      }
      return [slots[at].value, slots[at].set];
    },
    useRef(value) { return slots[index++] ??= { current: value }; },
    useEffect(fn, deps) {
      const at = index++;
      if (!slots[at] || !same(slots[at].deps, deps)) {
        pending.set(at, fn); slots[at] = { ...slots[at], deps };
      }
    },
  };
  const flush = () => {
    let loops = 0;
    while (dirty || pending.size) {
      if (++loops > 50) throw new Error('Hook failed to settle');
      if (dirty) { dirty = false; index = 0; result = render(); }
      const effects = [...pending]; pending.clear();
      for (const [at, fn] of effects) { slots[at].cleanup?.(); slots[at].cleanup = fn(); }
    }
    return result;
  };
  return { react, flush,
    start(fn) { render = fn; return flush(); },
    rerender() { dirty = true; return flush(); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); return flush(); },
    close() { for (const slot of slots) slot?.cleanup?.(); },
  };
};
