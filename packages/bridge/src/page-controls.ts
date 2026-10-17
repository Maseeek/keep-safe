import { randomUUID } from 'node:crypto';
import type { ElementHandle, JSHandle, Page } from 'playwright';
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
  targets: Map<string, { element: ElementHandle<Element>; descriptor: Descriptor }>;
}

/** Deliberate plain-JavaScript source: tsx/esbuild rewrites nested function names
 * with module helpers that do not exist in Chromium. CDP evaluates this source
 * directly; no page eval()/Function constructor or injected global is needed.
 * Do not add field values, full AX snapshots, or link address reads.
 */
const inspectDOMSource = String.raw`(args) => {
  if (Date.now() > args.deadline) return false;
  const supported = ['textbox', 'button', 'checkbox', 'radio', 'combobox', 'link'];
  const selector = 'input,textarea,select,button,a[href],[role~="textbox"],[role~="button"],[role~="checkbox"],[role~="radio"],[role~="combobox"],[role~="link"]';
  const valueContent = 'input,textarea,select,option,[contenteditable]:not([contenteditable="false"]),[role~="textbox"],[role~="combobox"]';
  const ignoredText = valueContent + ',script,style,noscript,template';
  const normalized = (value) => (value ?? '').slice(0, 640).replace(/[\u0000-\u0020\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  function hidden(element) {
    if (element.closest('[hidden],[inert],[aria-hidden="true"]')) return true;
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return true;
    }
    return false;
  }
  function labelText(element) {
    if (element.matches(ignoredText) || element.closest(valueContent) || hidden(element)) return '';
    let text = ''; let examined = 0; let node = element.firstChild;
    while (node && text.length < 640 && examined++ < 200) {
      const skip = node instanceof Element && (node.matches(ignoredText) || hidden(node));
      if (node.nodeType === Node.TEXT_NODE) text += (node.textContent ?? '').slice(0, 640 - text.length) + ' ';
      if (!skip && node.firstChild) node = node.firstChild;
      else {
        while (node && node !== element && !node.nextSibling) node = node.parentNode;
        if (!node || node === element) break;
        node = node.nextSibling;
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
    if (!(element instanceof HTMLElement) || !visible(element)) return;
    const explicit = element.getAttribute('role')?.split(/\s+/).find(role => supported.includes(role));
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
    const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/).slice(0, 8) ?? [];
    if (labelledBy.length) name = normalized(labelledBy.map(id => { const label = document.getElementById(id); return label ? labelText(label) : ''; }).join(' '));
    name ||= normalized(element.getAttribute('aria-label'));
    if (!name && 'labels' in element) {
      const labels = element.labels;
      if (labels) name = normalized(Array.from(labels).slice(0, 8).map(labelText).join(' '));
    }
    if (!name && ['button', 'link', 'checkbox', 'radio'].includes(role)) name = labelText(element);
    name ||= normalized(element.getAttribute('title'));
    name ||= normalized(element.getAttribute('placeholder'));
    const disabled = element.matches(':disabled') || !!element.closest('[aria-disabled="true"],[inert]');
    const result = { role, name, protected: element instanceof HTMLInputElement && element.type === 'password', disabled };
    if (role === 'checkbox' || role === 'radio') {
      if (element instanceof HTMLInputElement) result.checked = element.checked;
      else { const checked = element.getAttribute('aria-checked'); if (checked === 'true' || checked === 'false') result.checked = checked === 'true'; }
    }
    return result;
  }
  const sameTarget = (actual, expected) => actual && expected && !actual.disabled && !expected.disabled && actual.role === expected.role && actual.name === expected.name && actual.protected === expected.protected;
  if (args.operation === 'focus' || args.operation === 'verify') {
    const target = args.element;
    if (!(target instanceof HTMLElement) || !sameTarget(describe(target), args.expected)) return false;
    // Native focus only. Website focus handlers can still navigate or change DOM.
    if (Date.now() > args.deadline) return false;
    if (args.operation === 'focus') HTMLElement.prototype.focus.call(target);
    return Date.now() <= args.deadline && document.activeElement === target && !!sameTarget(describe(target), args.expected);
  }
  const metadata = []; const elements = [];
  const candidates = document.querySelectorAll(selector);
  let truncated = candidates.length > 200;
  for (let index = 0; index < Math.min(candidates.length, 200); index++) {
    const element = candidates[index]; const descriptor = describe(element);
    if (!descriptor) continue;
    if (metadata.length >= 50) { truncated = true; break; }
    metadata.push(descriptor); elements.push(element);
  }
  return { metadata, elements, truncated };
}`;

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
    return Promise.allSettled([...(previous?.targets.values() ?? [])].map(target => target.element.dispose()).concat(previous ? [previous.runner.dispose()] : [])).then(() => {});
  }
  function samePage(snapshot: Snapshot) {
    return current === snapshot && activePage() === snapshot.page && !snapshot.page.isClosed() && snapshot.page.url() === snapshot.url;
  }
  return {
    clear,
    async inspect(): Promise<PageControlsSnapshot> {
      const disposing = clear();
      const version = generation;
      await disposing;
      if (generation !== version) throw new Error('The page changed. Refresh the controls.');
      const page = activePage(); const url = page.url(); const origin = new URL(url).origin;
      if (page.isClosed() || !['http:', 'https:'].includes(new URL(url).protocol)) throw new Error('Open a website page before inspecting controls.');
      let result: JSHandle | undefined; let runner: JSHandle<DomRunner> | undefined; const temporary: JSHandle[] = []; const retained = new Map<string, { element: ElementHandle<Element>; descriptor: Descriptor }>(); let installed = false;
      const deadline = Date.now() + 2000;
      const work = (async () => {
        try {
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
          const snapshot: Snapshot = { id: randomUUID(), page, url, origin, runner, targets: retained };
          current = snapshot; installed = true;
          return { snapshotId: snapshot.id, origin, controls, truncated };
        } finally {
          const kept = new Set<JSHandle>();
          if (installed) { for (const target of retained.values()) kept.add(target.element); if (runner) kept.add(runner); }
          await Promise.allSettled([...temporary, ...(result ? [result] : [])].filter(handle => !kept.has(handle)).map(handle => handle.dispose()));
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
          const focused = await snapshot.runner.evaluate((run, args) => run(args), { operation: 'focus' as const, element: target.element, expected: target.descriptor, deadline });
          if (focused !== true || !samePage(snapshot)) return false;
          // A separate renderer round trip lets immediate focus-triggered
          // navigation invalidate the snapshot before acknowledgement.
          return snapshot.runner.evaluate((run, args) => run(args), { operation: 'verify' as const, element: target.element, expected: target.descriptor, deadline });
        })();
        const focused = await bounded(work, () => { if (current === snapshot) void clear(); });
        // Cross-process navigation/popup events and the current URL must still
        // agree after focus handlers finish, before a focus acknowledgement.
        if (focused !== true || !samePage(snapshot)) throw new Error('The selected control changed.');
      } catch { if (current === snapshot) await clear(); throw new Error('The control is no longer available. Refresh the controls and try again.'); }
    },
  };
}
