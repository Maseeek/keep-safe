import { useLayoutEffect, type RefObject } from "react";
import { ClassicSurface } from "./ClassicSurface";
import { GestureSurface } from "./GestureSurface";
import type { Screen } from "./screen";
import type { BrowserFrame, Workspace } from "./workspace";

export interface SurfaceProps {
  frame: BrowserFrame;
  /** Where the page image comes from. */
  screen: Screen;
  enabled: boolean;
  controlIdentity: unknown;
  alt: string;
  send: Workspace["send"];
  /** Displayed size in CSS pixels, chosen by the stage so the image fills it. */
  display?: { width: number; height: number };
  /** Called for every accepted tap, with viewport coordinates for local feedback. */
  onTap?: (point: { clientX: number; clientY: number }) => void;
}

/** Puts each new image straight into the element. The previous image stays
 * visible until the next has decoded, so the view never flashes. */
export function useScreenImage(image: RefObject<HTMLImageElement | null>, screen: Screen) {
  useLayoutEffect(() => {
    const show = (source: string | null) => { if (image.current && source) image.current.src = source; };
    show(screen.current());
    return screen.subscribe(show);
  }, [image, screen]);
}

/** The live page. A browser that takes raw gestures behaves like the phone's
 * own: the website sees the finger and decides what a drag means. */
export function RemoteSurface(props: SurfaceProps) {
  return props.frame.gestures ? <GestureSurface {...props} /> : <ClassicSurface {...props} />;
}
