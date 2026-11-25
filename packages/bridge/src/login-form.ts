import type { ElementHandle, Frame, JSHandle, Page } from 'playwright';
import type { FormField, FormFieldKind, FormStage, FormState, FormSubmitValue } from '../../shared/src/protocol';

interface DetectedField extends FormField {
  index: number;
}

interface DetectedForm {
  fields: DetectedField[];
  hasSubmit: boolean;
  challenge: 'none' | 'push' | 'captcha';
}

/**
 * Plain-JavaScript page scanner for login and 2FA form steps.
 * Kept free of TypeScript/tsx helpers so CDP can evaluate it cleanly even under
 * strict CSP without unsafe-eval. Never reads input values or exports page text.
 */
const inspectFormSource = String.raw`(() => {
  return (args) => {
    const deadline = args.deadline;
    let work = 0;
    const budget = () => ++work <= 30000 && Date.now() <= deadline;
    const norm = (value) => (value ?? '').slice(0, 240).replace(/[\u0000-\u0020\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    function parent(node) {
      if ((node instanceof Element || node instanceof Text) && node.assignedSlot) return node.assignedSlot;
      if (node instanceof ShadowRoot) return node.mode === 'open' ? node.host : null;
      return node.parentNode;
    }
    function hidden(element) {
      let current = element; let depth = 0;
      while (current && depth++ < 64) {
        if (!budget() || (current instanceof ShadowRoot && current.mode !== 'open')) return true;
        if (current instanceof Element) {
          if (current.matches('[hidden],[inert],[aria-hidden="true"]')) return true;
          const style = getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return true;
        }
        current = parent(current);
      }
      return false;
    }
    function visible(element) {
      if (!element.isConnected || hidden(element)) return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && element.getClientRects().length > 0;
    }
    function disabled(element) {
      let current = element; let depth = 0;
      while (current && depth++ < 32) {
        if (current instanceof Element && current.matches(':disabled,[disabled],[aria-disabled="true"],[inert]')) return true;
        current = parent(current);
      }
      return false;
    }
    function labelOf(element) {
      const root = element.getRootNode();
      const ids = (element.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4);
      if (ids.length && (root instanceof Document || (root instanceof ShadowRoot && root.mode === 'open'))) {
        const joined = norm(ids.map(id => {
          const node = root.getElementById(id);
          return node && !hidden(node) ? (node.textContent || '') : '';
        }).join(' '));
        if (joined) return joined;
      }
      const aria = norm(element.getAttribute('aria-label'));
      if (aria) return aria;
      if ('labels' in element && element.labels && element.labels.length) {
        const parts = [];
        for (let i = 0; i < Math.min(element.labels.length, 4); i++) {
          const lbl = element.labels[i];
          if (!hidden(lbl)) parts.push(lbl.textContent || '');
        }
        const joined = norm(parts.join(' '));
        if (joined) return joined;
      }
      return norm(element.getAttribute('placeholder')) || norm(element.getAttribute('title')) || '';
    }
    const otpPattern = /(one[- ]?time|2fa|two[- ]?factor|totp|\botp\b|authenticator|verification code|security code|passcode|6[- ]?digit|confirmation code|\bcode\b|\bpin\b)/i;
    const emailPattern = /e-?mail/i;
    const userPattern = /(user(name)?|login|account|identifier|handle|phone|mobile|member)/i;
    const submitPattern = /^(sign in|log in|login|next|continue|verify|submit|confirm|unlock|go)$/i;

    const rawInputs = [];
    const submitButtons = [];
    const stack = [{ next: document.documentElement, depth: 0, shadows: 0 }];
    let visited = 0;
    while (stack.length && visited < 4000 && budget()) {
      const frame = stack[stack.length - 1];
      const node = frame.next;
      if (!node) { stack.pop(); continue; }
      frame.next = node.nextSibling;
      visited++;
      if (!(node instanceof Element)) continue;
      if (node instanceof HTMLInputElement) {
        const type = (node.type || 'text').toLowerCase();
        if (['text', 'email', 'password', 'tel', 'number'].includes(type) && !node.readOnly && visible(node) && !disabled(node)) {
          rawInputs.push({ el: node, type, ac: (node.getAttribute('autocomplete') || '').toLowerCase(), im: (node.getAttribute('inputmode') || '').toLowerCase(), name: (node.name || '').toLowerCase(), id: (node.id || '').toLowerCase(), maxLength: node.maxLength, label: labelOf(node), required: node.required });
        } else if (['submit', 'button'].includes(type) && visible(node) && !disabled(node)) {
          const text = norm(node.value || node.getAttribute('aria-label'));
          if (type === 'submit' || submitPattern.test(text)) submitButtons.push({ el: node, primary: type === 'submit' || submitPattern.test(text) });
        }
      } else if ((node instanceof HTMLButtonElement || node.getAttribute('role') === 'button') && visible(node) && !disabled(node)) {
        const type = node instanceof HTMLButtonElement ? (node.getAttribute('type') || 'submit').toLowerCase() : 'button';
        const text = norm(node.textContent || node.getAttribute('aria-label'));
        if (type === 'submit' || submitPattern.test(text)) submitButtons.push({ el: node, primary: (type === 'submit' && submitPattern.test(text)) || submitPattern.test(text) });
      }
      const shadow = node.shadowRoot;
      if (frame.depth < 48) {
        if (node.firstChild) stack.push({ next: node.firstChild, depth: frame.depth + 1, shadows: frame.shadows });
        if (shadow?.mode === 'open' && frame.shadows < 16 && shadow.firstChild) stack.push({ next: shadow.firstChild, depth: frame.depth + 1, shadows: frame.shadows + 1 });
      }
    }

    const hasPassword = rawInputs.some(item => item.type === 'password');
    const fields = [];
    const elements = [];
    const seenKinds = new Set();

    for (const item of rawInputs) {
      const clue = [item.label, item.name, item.id, item.ac].join(' ');
      let kind = null;
      if (item.type === 'password') {
        kind = 'password';
      } else if (item.ac.includes('one-time-code') || ((item.im === 'numeric' || item.type === 'number' || (item.maxLength >= 4 && item.maxLength <= 8)) && otpPattern.test(clue)) || otpPattern.test(item.label)) {
        kind = 'otp';
      } else if (item.type === 'email' || item.ac.includes('email') || emailPattern.test(clue)) {
        kind = 'email';
      } else if (item.ac.includes('username') || userPattern.test(clue) || (hasPassword && (item.type === 'text' || item.type === 'tel'))) {
        kind = 'username';
      }
      if (!kind || seenKinds.has(kind)) continue;
      seenKinds.add(kind);
      const fallback = kind === 'email' ? 'Email' : kind === 'username' ? 'Username' : kind === 'password' ? 'Password' : 'Verification code';
      fields.push({ kind, label: item.label || fallback, required: item.required, index: elements.length });
      elements.push(item.el);
      if (fields.length >= 4) break;
    }

    // Choose the best submit button: prefer one inside the same form as the first input.
    const primaryForm = elements[0]?.form || null;
    let submitEl = null;
    if (primaryForm) {
      submitEl = submitButtons.find(b => b.el.form === primaryForm && b.primary)?.el
        || submitButtons.find(b => b.el.form === primaryForm)?.el
        || null;
    }
    if (!submitEl) submitEl = submitButtons.find(b => b.primary)?.el || submitButtons[0]?.el || null;

    // Require an actual <form>, a submit action, or an OTP box so pages with
    // standalone unsubmittable inputs stay in the live browser.
    const inForm = elements.some(el => el instanceof HTMLInputElement && !!el.form);
    const hasOtp = fields.some(f => f.kind === 'otp');
    const usable = fields.length > 0 && (inForm || !!submitEl || hasOtp);
    const effectiveFields = usable ? fields : [];
    const effectiveElements = usable ? elements : [];

    // Detect 2FA push approval or CAPTCHA hints without ever exporting raw page text.
    let challenge = 'none';
    if (effectiveFields.length === 0) {
      const sample = (document.body?.innerText || '').slice(0, 4000);
      if (/(captcha|i['’]m not a robot|verify you are human|complete the puzzle)/i.test(sample)) challenge = 'captcha';
      else if (/(check your phone|approve (the )?sign[- ]?in|tap yes|authenticator app|verify it['’]s you|confirm on your device|security key|passkey|push notification|number matching)/i.test(sample)) challenge = 'push';
    }

    return { fields: effectiveFields, elements: effectiveElements, submitEl, hasSubmit: !!submitEl, challenge };
  };
})()`;

const sleep = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/** Human-like typing cadence with slight jitter, bounded so even long secrets finish quickly. */
export async function humanTypeCdp(page: Page, value: string): Promise<void> {
  const chars = [...value];
  // Cap total typing time near ~450ms for very long passwords while keeping per-key jitter.
  const maxPerChar = chars.length > 0 ? Math.min(28, Math.max(4, Math.floor(450 / chars.length))) : 15;
  const minPerChar = Math.max(2, Math.floor(maxPerChar * 0.45));
  for (const char of chars) {
    if (char === '\n' || char === '\r') continue;
    if ([...char].length === 1 && char.codePointAt(0)! >= 0x20 && char.codePointAt(0)! <= 0x7e) {
      await page.keyboard.type(char);
    } else {
      await page.keyboard.insertText(char);
    }
    const jitter = minPerChar + Math.floor(Math.random() * Math.max(1, maxPerChar - minPerChar + 1));
    await sleep(jitter);
  }
}

interface ScanResult {
  origin: string;
  url: string;
  detected: DetectedForm;
  elements: ElementHandle<Element>[];
  submitEl: ElementHandle<Element> | null;
  dispose(): Promise<void>;
}

async function scanFrame(frame: Frame, deadline: number): Promise<ScanResult | null> {
  const url = frame.url();
  const origin = originOf(url);
  if (!origin || frame.isDetached()) return null;
  const handles: JSHandle[] = [];
  let retained: ElementHandle<Element>[] = [];
  let submitEl: ElementHandle<Element> | null = null;
  let kept = false;
  try {
    const runner = await frame.evaluateHandle(inspectFormSource); handles.push(runner);
    const result = await runner.evaluateHandle((run: (a: { deadline: number }) => unknown, args) => run(args), { deadline }); handles.push(result);
    const fieldsHandle = await result.getProperty('fields'); handles.push(fieldsHandle);
    const fields = await fieldsHandle.jsonValue() as DetectedField[];
    const hasSubmitHandle = await result.getProperty('hasSubmit'); handles.push(hasSubmitHandle);
    const hasSubmit = await hasSubmitHandle.jsonValue() as boolean;
    const challengeHandle = await result.getProperty('challenge'); handles.push(challengeHandle);
    const challenge = await challengeHandle.jsonValue() as DetectedForm['challenge'];
    const elementsHandle = await result.getProperty('elements'); handles.push(elementsHandle);
    const props = await elementsHandle.getProperties();
    const elements: ElementHandle<Element>[] = [];
    for (let i = 0; i < fields.length; i++) {
      const el = props.get(String(i))?.asElement() as ElementHandle<Element> | null | undefined;
      if (el) elements.push(el);
    }
    for (const handle of props.values()) if (!elements.includes(handle as ElementHandle<Element>)) handles.push(handle);
    const submitHandle = await result.getProperty('submitEl');
    submitEl = submitHandle.asElement() as ElementHandle<Element> | null;
    if (!submitEl) handles.push(submitHandle);
    retained = elements;
    kept = true;
    return {
      origin,
      url,
      detected: { fields, hasSubmit, challenge },
      elements,
      submitEl,
      async dispose() {
        await Promise.allSettled([
          ...retained.map(el => el.dispose()),
          ...(submitEl ? [submitEl.dispose()] : []),
        ]);
      },
    };
  } catch {
    return null;
  } finally {
    await Promise.allSettled([
      ...handles.map(h => h.dispose()),
      ...(!kept ? [...retained.map(el => el.dispose()), ...(submitEl ? [submitEl.dispose()] : [])] : []),
    ]);
  }
}

export interface LoginFormController {
  inspect(): Promise<FormState>;
  submit(values: FormSubmitValue[], expectedOrigin?: string): Promise<{ ok: boolean; message?: string; state: FormState }>;
}

/**
 * Tracks login form stages and performs trusted, human-like form filling on a
 * CDP-controlled browser page without ever exposing values to the agent.
 */
export function createLoginFormController(activePage: () => Page, initialUrl: string): LoginFormController {
  const initialPath = pathOf(initialUrl);
  let sawLoginForm = false;
  let submittedOnce = false;

  const toFormState = (scan: ScanResult | null, fallbackUrl: string): FormState => {
    const url = scan?.url ?? fallbackUrl;
    const origin = scan?.origin ?? originOf(fallbackUrl);
    if (!scan || !origin) return { stage: 'browser', origin, fields: [] };
    const { fields, challenge } = scan.detected;
    if (fields.some(f => f.kind === 'otp')) {
      sawLoginForm = true;
      const otpFields = fields.filter(f => f.kind === 'otp').map(({ kind, label, required }) => ({ kind, label, ...(required ? { required } : {}) }));
      return { stage: 'otp', origin, fields: otpFields, hint: 'Enter the verification code sent to you.', canSubmit: true };
    }
    if (fields.length > 0) {
      sawLoginForm = true;
      return {
        stage: 'credentials',
        origin,
        fields: fields.map(({ kind, label, required }) => ({ kind, label, ...(required ? { required } : {}) })),
        canSubmit: true,
      };
    }
    if (challenge === 'push') {
      return { stage: 'challenge', origin, fields: [], hint: 'Approve the sign-in prompt on your phone or authenticator app.' };
    }
    if (challenge === 'captcha') {
      return { stage: 'browser', origin, fields: [], hint: 'Complete the verification in the live browser.' };
    }
    if ((sawLoginForm || submittedOnce) && pathOf(url) !== initialPath) {
      return { stage: 'signed-in', origin, fields: [], hint: 'Looks like you\u2019re signed in. Check or hand back to your agent.' };
    }
    return { stage: 'browser', origin, fields: [] };
  };

  async function scanActive(): Promise<{ page: Page; scan: ScanResult | null }> {
    const page = activePage();
    if (page.isClosed()) return { page, scan: null };
    const scan = await scanFrame(page.mainFrame(), Date.now() + 2500);
    return { page, scan };
  }

  async function inspect(): Promise<FormState> {
    const { page, scan } = await scanActive();
    try {
      return toFormState(scan, page.isClosed() ? '' : page.url());
    } finally {
      await scan?.dispose();
    }
  }

  async function clickAndType(page: Page, element: ElementHandle<Element>, value: string, isPassword: boolean): Promise<boolean> {
    try {
      // Verify password values ONLY land in an actual type="password" input.
      if (isPassword) {
        const valid = await element.evaluate(el => el instanceof HTMLInputElement && el.type === 'password' && !el.disabled && !el.readOnly).catch(() => false);
        if (!valid) return false;
      }
      const box = await element.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        // Aim near center with slight natural offset.
        const jitterX = (Math.random() - 0.5) * Math.min(8, box.width * 0.2);
        const jitterY = (Math.random() - 0.5) * Math.min(4, box.height * 0.2);
        await page.mouse.click(box.x + box.width / 2 + jitterX, box.y + box.height / 2 + jitterY);
      } else {
        await element.focus();
      }
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Backspace');
      await humanTypeCdp(page, value);
      return true;
    } catch {
      return false;
    }
  }

  async function triggerSubmit(page: Page, submitEl: ElementHandle<Element> | null): Promise<void> {
    if (submitEl) {
      const box = await submitEl.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        return;
      }
    }
    await page.keyboard.press('Enter');
  }

  async function waitForTransition(page: Page, previousUrl: string, previousKinds: string, timeoutMs: number): Promise<FormState> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end && !page.isClosed()) {
      await sleep(180);
      const next = await inspect();
      const kinds = next.fields.map(f => f.kind).join(',');
      if (page.url() !== previousUrl || kinds !== previousKinds) {
        // Let immediate post-navigation DOM settle briefly.
        await sleep(160);
        return inspect();
      }
    }
    return inspect();
  }

  async function fillStep(values: FormSubmitValue[], expectedOrigin?: string): Promise<{ filledKinds: Set<FormFieldKind>; submitted: boolean; mismatch?: boolean; state?: FormState }> {
    const { page, scan } = await scanActive();
    if (!scan || page.isClosed()) return { filledKinds: new Set(), submitted: false };
    try {
      if (expectedOrigin && scan.origin !== expectedOrigin) {
        return { filledKinds: new Set(), submitted: false, mismatch: true, state: toFormState(scan, page.url()) };
      }
      const filledKinds = new Set<FormFieldKind>();
      const valueFor = (kind: FormFieldKind): FormSubmitValue | undefined => {
        const direct = values.find(item => item.kind === kind && item.value.length > 0);
        if (direct) return direct;
        // Treat email and username interchangeably when the form asks for one and the user provided the other.
        if (kind === 'email') return values.find(item => item.kind === 'username' && item.value.length > 0);
        if (kind === 'username') return values.find(item => item.kind === 'email' && item.value.length > 0);
        return undefined;
      };

      for (const field of scan.detected.fields) {
        const candidate = valueFor(field.kind);
        if (!candidate) continue;
        const el = scan.elements[field.index];
        if (!el) continue;
        const ok = await clickAndType(page, el, candidate.value, field.kind === 'password');
        if (ok) {
          filledKinds.add(field.kind);
          filledKinds.add(candidate.kind);
        }
      }

      if (filledKinds.size === 0) return { filledKinds, submitted: false, state: toFormState(scan, page.url()) };
      const previousUrl = page.url();
      const previousKinds = scan.detected.fields.map(f => f.kind).join(',');
      submittedOnce = true;
      await triggerSubmit(page, scan.submitEl).catch(() => {});
      const nextState = await waitForTransition(page, previousUrl, previousKinds, 2500);
      return { filledKinds, submitted: true, state: nextState };
    } finally {
      await scan.dispose();
    }
  }

  async function submit(values: FormSubmitValue[], expectedOrigin?: string): Promise<{ ok: boolean; message?: string; state: FormState }> {
    const first = await fillStep(values, expectedOrigin);
    if (first.mismatch) {
      return { ok: false, message: 'The website address changed before filling. Check the address and try again.', state: first.state ?? await inspect() };
    }
    if (!first.submitted) {
      const state = first.state ?? await inspect();
      return { ok: false, message: 'No matching field was ready on this page. Switch to the live browser to continue.', state };
    }

    // Two-step login support (e.g. Email → Next → Password):
    // If the user supplied a password that wasn't on step 1, and step 2 now shows a password field on the same origin, fill it automatically.
    const pendingPassword = values.find(item => item.kind === 'password' && item.value.length > 0);
    if (pendingPassword && !first.filledKinds.has('password')) {
      const step2State = first.state ?? await inspect();
      if (step2State.stage === 'credentials' && step2State.fields.some(f => f.kind === 'password') && (!expectedOrigin || step2State.origin === expectedOrigin)) {
        const second = await fillStep([pendingPassword], expectedOrigin);
        if (second.mismatch) {
          return { ok: false, message: 'The website address changed before entering your password. Check the live browser.', state: second.state ?? await inspect() };
        }
        return { ok: second.submitted, state: second.state ?? await inspect() };
      }
    }

    return { ok: true, state: first.state ?? await inspect() };
  }

  return { inspect, submit };
}
