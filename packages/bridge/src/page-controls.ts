import { randomUUID } from 'node:crypto';
import type { CDPSession, ElementHandle, JSHandle, Page } from 'playwright';
import type { PageControl, PageControlsSnapshot } from '../../shared/src/protocol';

type Descriptor = Omit<PageControl, 'id'>;
type DomArgs = { operation: 'inspect' | 'focus' | 'verify'; element?: Element; expected?: Descriptor; deadline: number };
type DomRunner = (args: DomArgs) => unknown;
interface Snapshot {
  id: string;
  page: Page;
  url: string;
  origin: string;
  runner: JSHandle<DomRunner>;
  navigation: NavigationGuard;
  targets: Map<string, { element: ElementHandle<Element>; descriptor: Descriptor }>;
}

interface NavigationGuard { session: CDPSession; release(): Promise<void> }

async function watchNavigation(page: Page, invalidate: () => void): Promise<NavigationGuard> {
  const session = await page.context().newCDPSession(page);
  let mainFrameId: string | undefined;
  const navigation = (event: { frameId: string }) => { if (!mainFrameId || event.frameId === mainFrameId) invalidate(); };
  const popup = () => invalidate();
  session.on('Page.frameRequestedNavigation', navigation);
  session.on('Page.frameScheduledNavigation', navigation);
  session.on('Page.windowOpen', popup);
  const release = async () => {
    session.off('Page.frameRequestedNavigation', navigation);
    session.off('Page.frameScheduledNavigation', navigation);
    session.off('Page.windowOpen', popup);
    await session.detach().catch(() => {});
  };
  try {
    await session.send('Page.enable');
    // Read only the root frame identifier, never page content or frame URLs.
    mainFrameId = (await session.send('Page.getFrameTree')).frameTree.frame.id;
    return { session, release };
  } catch (error) { await release(); throw error; }
}

/** Deliberate plain-JavaScript source: tsx/esbuild rewrites nested function names
 * with module helpers that do not exist in Chromium. CDP evaluates this source
 * directly; no page eval()/Function constructor or injected global is needed.
 * Do not add field values, full AX snapshots, or link address reads.
 */
const inspectDOMSource = String.raw`(() => {
 const paths = new WeakMap();
 return (args) => {
  if (Date.now() > args.deadline) return false;
  const supported = ['textbox', 'button', 'checkbox', 'radio', 'combobox', 'link'];
  const selector = 'input,textarea,select,button,a[href],[role~="textbox"],[role~="button"],[role~="checkbox"],[role~="radio"],[role~="combobox"],[role~="link"]';
  const valueContent = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role~="textbox"],[role~="combobox"]';
  const ignoredText = valueContent + ',script,style,noscript,template';
  const normalized = (value) => (value ?? '').slice(0, 640).replace(/[\u0000-\u0020\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  let work = 0; let exhausted = false; let textLimited = false;
  const seenRoots = new WeakSet(); let rootCount = 0;
  function budget() {
    if (++work > 50000 || Date.now() > args.deadline) { exhausted = true; return false; }
    return true;
  }
  function parent(node) {
    if ((node instanceof Element || node instanceof Text) && node.assignedSlot) return node.assignedSlot;
    if (node instanceof ShadowRoot) return node.mode === 'open' ? node.host : null;
    return node.parentNode;
  }
  function ancestors(element, test) {
    let current = element; let depth = 0;
    while (current && depth++ < 128) {
      if (!budget() || (current instanceof ShadowRoot && current.mode !== 'open')) return true;
      if (current instanceof Element && test(current)) return true;
      current = parent(current);
    }
    if (current) { exhausted = true; return true; }
    return false;
  }
  function path(element) {
    const nodes = [element.getRootNode()]; let node = element; let depth = 0;
    while (node && depth++ < 128) {
      if (!budget() || (node instanceof ShadowRoot && node.mode !== 'open')) return;
      nodes.push(node); node = parent(node);
    }
    if (node) { exhausted = true; return; }
    return nodes;
  }
  function samePath(element) {
    const previous = paths.get(element); const current = path(element);
    return !!previous && !!current && previous.length === current.length && previous.every((node, index) => node === current[index]);
  }
  function hidden(element) {
    return ancestors(element, current => {
      if (current.matches('[hidden],[inert],[aria-hidden="true"]')) return true;
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return true;
      return false;
    });
  }
  function openRoot(element) {
    const root = element.shadowRoot;
    if (root?.mode !== 'open') return null;
    if (!seenRoots.has(root)) {
      if (++rootCount > 100) { exhausted = true; return null; }
      seenRoots.add(root);
    }
    return root;
  }
  function labelText(element) {
    if (!budget() || element.matches(ignoredText) || ancestors(element, current => current.matches(valueContent)) || hidden(element)) return '';
    let text = ''; let examined = 0;
    function visit() {
      if (examined++ >= 200) { textLimited = true; return false; }
      return budget();
    }
    function children(owner, depth, shadows) {
      if (depth > 64 || shadows > 24) { textLimited = true; return; }
      if (owner instanceof HTMLSlotElement) {
        const root = owner.getRootNode();
        if (root instanceof ShadowRoot && root.mode === 'open') {
          // assignedNodes() allocates the whole assignment list. Scan only the
          // host's direct children, under the same label/work budgets instead.
          let child = root.host.firstChild;
          while (child) {
            if (!visit()) return;
            if (child.assignedSlot === owner) return { next: child, slot: owner, depth, shadows };
            child = child.nextSibling;
          }
        }
      }
      const root = openRoot(owner);
      if (root && shadows >= 24) { textLimited = true; return; }
      return { next: root ? root.firstChild : owner.firstChild, depth, shadows: shadows + (root ? 1 : 0) };
    }
    const lineage = path(element);
    if (!lineage) return '';
    const shadowAncestors = new Set(); let depth = -1;
    for (const node of lineage) {
      if (node instanceof ShadowRoot) shadowAncestors.add(node);
      else if (node instanceof Element) depth++;
    }
    const initial = children(element, depth, shadowAncestors.size); const stack = initial ? [initial] : [];
    while (stack.length && text.length < 640 && !exhausted) {
      const frame = stack[stack.length - 1]; const node = frame.next;
      if (!node) { stack.pop(); continue; }
      if (!visit()) break;
      frame.next = node.nextSibling;
      if (frame.slot && node.assignedSlot !== frame.slot) continue;
      if (node instanceof Text) {
        if (ancestors(node, current => current.matches(valueContent)) || hidden(node)) continue;
        // This also excludes unassigned light text under a closed host without
        // reading its closed root. Bound the range before any text is read.
        const length = Math.min(node.length, 640 - text.length);
        if (!length) continue;
        const range = document.createRange(); range.setStart(node, 0); range.setEnd(node, length);
        const box = range.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) text += node.data.slice(0, length) + ' ';
      } else if (node instanceof Element && !node.matches(ignoredText) && !ancestors(node, current => current.matches(valueContent)) && !hidden(node)) {
        const next = children(node, frame.depth + 1, frame.shadows);
        if (next) stack.push(next);
      }
    }
    return normalized(text);
  }
  function visible(element) {
    if (!element.isConnected || hidden(element)) return false;
    const box = element.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0 || !element.getClientRects().length) return false;
    return true;
  }
  function describe(element) {
    if (!budget() || !(element instanceof HTMLElement) || !visible(element)) return;
    const explicit = element.getAttribute('role')?.slice(0, 128).split(/\s+/).find(role => supported.includes(role));
    let role = explicit;
    if (!role) {
      if (element instanceof HTMLInputElement) {
        if (['text', 'password', 'email', 'search', 'url', 'tel', 'number'].includes(element.type)) role = 'textbox';
        else if (element.type === 'checkbox') role = 'checkbox';
        else if (element.type === 'radio') role = 'radio';
        else if (['button', 'submit', 'reset', 'image'].includes(element.type)) role = 'button';
      } else if (element instanceof HTMLTextAreaElement) role = 'textbox';
      else if (element instanceof HTMLSelectElement && !element.multiple) role = 'combobox';
      else if (element instanceof HTMLButtonElement) role = 'button';
      else if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) role = 'link';
    }
    if (!role) return;
    let name = '';
    const labelledBy = element.getAttribute('aria-labelledby')?.slice(0, 1280).split(/\s+/).slice(0, 8) ?? [];
    const root = element.getRootNode();
    if (labelledBy.length && (root instanceof Document || (root instanceof ShadowRoot && root.mode === 'open'))) name = normalized(labelledBy.map(id => { const label = root.getElementById(id); return label ? labelText(label) : ''; }).join(' '));
    name ||= normalized(element.getAttribute('aria-label'));
    if (!name && 'labels' in element) {
      const labels = element.labels;
      if (labels) { const texts = []; for (let index = 0; index < Math.min(labels.length, 8); index++) texts.push(labelText(labels[index])); name = normalized(texts.join(' ')); }
    }
    if (!name && ['button', 'link', 'checkbox', 'radio'].includes(role)) name = labelText(element);
    name ||= normalized(element.getAttribute('title'));
    name ||= normalized(element.getAttribute('placeholder'));
    const disabled = ancestors(element, current => current.matches(':disabled,[disabled],[aria-disabled="true"],[inert]'));
    const result = { role, name, protected: element instanceof HTMLInputElement && element.type === 'password', disabled };
    if (role === 'checkbox' || role === 'radio') {
      if (element instanceof HTMLInputElement) result.checked = element.checked;
      else { const checked = element.getAttribute('aria-checked'); if (checked === 'true' || checked === 'false') result.checked = checked === 'true'; }
    }
    return exhausted ? undefined : result;
  }
  const sameTarget = (actual, expected) => actual && expected && !actual.disabled && !expected.disabled && actual.role === expected.role && actual.name === expected.name && actual.protected === expected.protected;
  function activeTarget() {
    let element = document.activeElement; let depth = 0;
    while (element?.shadowRoot?.mode === 'open' && element.shadowRoot.activeElement && depth++ < 24) {
      if (!budget()) return;
      element = element.shadowRoot.activeElement;
    }
    if (element?.shadowRoot?.activeElement) return;
    return element;
  }
  if (args.operation === 'focus' || args.operation === 'verify') {
    const target = args.element;
    if (!(target instanceof HTMLElement) || !samePath(target) || !sameTarget(describe(target), args.expected)) return false;
    // Native focus only. Website focus handlers can still navigate or change DOM.
    if (Date.now() > args.deadline) return false;
    if (args.operation === 'focus') HTMLElement.prototype.focus.call(target);
    return Date.now() <= args.deadline && activeTarget() === target && samePath(target) && !!sameTarget(describe(target), args.expected);
  }
  const metadata = []; const elements = [];
  // Incremental DFS retains only the bounded ancestor frames, never an entire
  // document-wide NodeList or all children of a wide container.
  const stack = [{ next: document.documentElement, depth: 0, shadows: 0 }];
  let truncated = false; let visited = 0; let candidates = 0;
  while (stack.length) {
    if (!budget() || visited >= 3000) { truncated = true; break; }
    const frame = stack[stack.length - 1]; const node = frame.next;
    if (!node) { stack.pop(); continue; }
    frame.next = node.nextSibling; visited++;
    if (!(node instanceof Element)) continue;
    if (node.matches(selector)) {
      if (candidates++ >= 200) { truncated = true; break; }
      const descriptor = describe(node);
      if (exhausted) { truncated = true; break; }
      if (descriptor) {
        if (metadata.length >= 50) { truncated = true; break; }
        const lineage = path(node);
        if (exhausted) { truncated = true; break; }
        if (lineage) { paths.set(node, lineage); metadata.push(descriptor); elements.push(node); }
      }
    }
    const shadow = openRoot(node);
    if (exhausted) { truncated = true; break; }
    if ((node.firstChild || shadow?.firstChild) && frame.depth >= 64) { truncated = true; continue; }
    if (node.firstChild) stack.push({ next: node.firstChild, depth: frame.depth + 1, shadows: frame.shadows });
    if (shadow?.mode === 'open') {
      if (frame.shadows >= 24) { truncated = true; continue; }
      if (shadow.firstChild) stack.push({ next: shadow.firstChild, depth: frame.depth + 1, shadows: frame.shadows + 1 });
    }
  }
  return { metadata, elements, truncated: truncated || exhausted || textLimited };
 };
})()`;

async function bounded<T>(operation: Promise<T>, onTimeout: () => void): Promise<T> {
  let expired = false;
  const timer = setTimeout(() => { expired = true; onTimeout(); }, 2000);
  // Invalidation is bounded; the operation remains in the server's input barrier
  // until Chromium actually settles. A timeout is not cancellation of page JS.
  try { const result = await operation; if (expired) throw new Error('Page controls timed out. Refresh the controls and try again.'); return result; }
  finally { clearTimeout(timer); }
}

export function createPageControls(activePage: () => Page) {
  let current: Snapshot | undefined;
  let generation = 0;
  function clear(): Promise<void> {
    generation++;
    const previous = current; current = undefined;
    const releases = [...(previous?.targets.values() ?? [])].map(target => target.element.dispose());
    if (previous) releases.push(previous.runner.dispose(), previous.navigation.release());
    return Promise.allSettled(releases).then(() => {});
  }
  function samePage(snapshot: Snapshot) {
    return current === snapshot && activePage() === snapshot.page && !snapshot.page.isClosed() && snapshot.page.url() === snapshot.url;
  }
  return {
    clear,
    async inspect(): Promise<PageControlsSnapshot> {
      const deadline = Date.now() + 2000;
      const disposing = clear();
      const version = generation;
      await disposing;
      if (generation !== version || Date.now() > deadline) throw new Error('The page changed. Refresh the controls.');
      const page = activePage(); const url = page.url(); const origin = new URL(url).origin;
      if (page.isClosed() || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Open a website page before inspecting controls.');
      let result: JSHandle | undefined; let runner: JSHandle<DomRunner> | undefined; let navigation: NavigationGuard | undefined; const temporary: JSHandle[] = []; const retained = new Map<string, { element: ElementHandle<Element>; descriptor: Descriptor }>(); let installed = false;
      const work = (async () => {
        try {
          navigation = await watchNavigation(page, () => { if (generation === version) void clear(); });
          runner = await page.evaluateHandle(inspectDOMSource) as JSHandle<DomRunner>;
          temporary.push(runner);
          result = await runner.evaluateHandle((run, args) => run(args), { operation: 'inspect' as const, deadline });
          const metadataHandle = await result.getProperty('metadata'); temporary.push(metadataHandle);
          const descriptors = await metadataHandle.jsonValue() as Descriptor[];
          const truncatedHandle = await result.getProperty('truncated'); temporary.push(truncatedHandle);
          const truncated = await truncatedHandle.jsonValue() as boolean;
          const elements = await result.getProperty('elements'); temporary.push(elements);
          const properties = await elements.getProperties(); temporary.push(...properties.values());
          const controls: PageControl[] = [];
          for (let index = 0; index < Math.min(descriptors.length, 50); index++) {
            const element = properties.get(String(index))?.asElement() as ElementHandle<Element> | null | undefined;
            if (!element) continue;
            const id = randomUUID(); retained.set(id, { element, descriptor: descriptors[index] }); controls.push({ id, ...descriptors[index] });
          }
          if (generation !== version || activePage() !== page || page.url() !== url || page.isClosed()) throw new Error('The page changed. Refresh the controls.');
          const snapshot: Snapshot = { id: randomUUID(), page, url, origin, runner, navigation, targets: retained };
          current = snapshot; installed = true;
          return { snapshotId: snapshot.id, origin, controls, truncated };
        } finally {
          const kept = new Set<JSHandle>();
          if (installed) { for (const target of retained.values()) kept.add(target.element); if (runner) kept.add(runner); }
          await Promise.allSettled([
            ...[...temporary, ...(result ? [result] : [])].filter(handle => !kept.has(handle)).map(handle => handle.dispose()),
            ...(!installed && navigation ? [navigation.release()] : []),
          ]);
        }
      })();
      try { return await bounded(work, () => { if (generation === version) void clear(); }); }
      catch { if (generation === version) await clear(); throw new Error('Unable to inspect this page. Refresh the controls and try again.'); }
    },
    async focus(snapshotId: string, controlId: string): Promise<void> {
      const snapshot = current;
      const target = snapshot?.targets.get(controlId);
      if (!snapshot || snapshot.id !== snapshotId || !target || !samePage(snapshot)) throw new Error('These controls are stale. Refresh the controls and try again.');
      const deadline = Date.now() + 2000;
      try {
        const work = (async () => {
          // Use the guard's own CDP channel before and after focus so its
          // synchronous renderer navigation events precede acknowledgement.
          await snapshot.navigation.session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
          if (!samePage(snapshot)) return false;
          const focused = await snapshot.runner.evaluate((run, args) => run(args), { operation: 'focus' as const, element: target.element, expected: target.descriptor, deadline });
          if (focused !== true || !samePage(snapshot)) return false;
          const verified = await snapshot.runner.evaluate((run, args) => run(args), { operation: 'verify' as const, element: target.element, expected: target.descriptor, deadline });
          if (verified !== true || !samePage(snapshot)) return false;
          await snapshot.navigation.session.send('Runtime.evaluate', { expression: 'void 0', returnByValue: true });
          return samePage(snapshot);
        })();
        const focused = await bounded(work, () => { if (current === snapshot) void clear(); });
        // Cross-process navigation/popup events and the current URL must still
        // agree after focus handlers finish, before a focus acknowledgement.
        if (focused !== true || !samePage(snapshot)) throw new Error('The selected control changed.');
      } catch { if (current === snapshot) await clear(); throw new Error('The control is no longer available. Refresh the controls and try again.'); }
    },
  };
}
