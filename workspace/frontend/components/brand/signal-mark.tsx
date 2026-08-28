'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The 52hzAgents mark: a solid disc with two eyes and an X for a mouth, which
 * turns slowly to look around.
 *
 * Two colours and nothing else — a body and its features. No gradient, no
 * highlight, no underside, so there is not one soft edge to go to mush at 20px.
 * That leaves the turn carrying the roundness on its own, which it can, because
 * the foreshortening IS the shading.
 *
 * The palette does NOT follow the theme. A brand mark that restyles itself per
 * surface stops being a mark, so the body is one colour on both grounds — but it
 * is the colour the user picked in Settings → 通用与桌面 → 品牌标识, delivered as
 * a CSS variable on <html> (see lib/mark-color-store.ts). The literal below is
 * the fallback the SVG carries on its own, for the frame before the pre-paint
 * script runs and for anything that renders the mark outside the app shell.
 *
 * FEATURE stays fixed. Every preset is chosen to hold this near-black face, and
 * letting both ends move is how a mark ends up with an invisible one.
 */

const BODY = 'var(--signal-mark-body, #1C6EA4)';
const FEATURE = '#0B1013';

const BODY_PATH =
  'M50 20 C 72 20 86 36 87 55 C 88 76 74 92 50 92 C 26 92 12 76 13 55 C 14 36 28 20 50 20 Z';

export interface SignalMarkProps {
  /** Rendered edge length in px. Legible from 20 up. */
  size?: number;
  /** Hold it still — for dense lists, where a column of moving faces is a lot. */
  still?: boolean;
  className?: string;
  title?: string;
}

/**
 * Uniform randomness feels uniform. Weighting toward the low end gives the
 * bursts-then-stillness that reads as attention rather than patrol.
 */
function wait(min: number, max: number) {
  return min + Math.pow(Math.random(), 1.7) * (max - min);
}

export function SignalMark({ size = 24, still = false, className, title }: SignalMarkProps) {
  const root = React.useRef<SVGSVGElement>(null);
  const turn = React.useRef<SVGGElement>(null);
  const face = React.useRef<SVGGElement>(null);
  const socketL = React.useRef<SVGGElement>(null);
  const socketR = React.useRef<SVGGElement>(null);
  const mouth = React.useRef<SVGGElement>(null);
  const jaw = React.useRef<SVGGElement>(null);
  const flex = React.useRef<SVGGElement>(null);

  React.useEffect(() => {
    if (still) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const svg = root.current;
    if (!svg || !turn.current || !face.current || !socketL.current) return;

    // Cleared on unmount: a sidebar that remounts on navigation would otherwise
    // leave a driver per mount running against a detached node forever.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
      timers.add(t);
      return t;
    };

    let gaze = 0;

    // Foreshortening is ANISOTROPIC. A circle rotating away on a sphere becomes
    // an ellipse — squashed almost entirely across, barely at all vertically.
    // Scaling it down evenly reads as "moved further away" instead, which is
    // most of what makes a turn like this look machined.
    const eye = (el: SVGGElement | null, away: number) => {
      if (!el) return;
      const sx = away >= 0 ? 1 - away * 0.6 : 1 - away * 0.14;
      const sy = away >= 0 ? 1 - away * 0.11 : 1 - away * 0.06;
      el.style.transform = `scale(${sx.toFixed(3)},${sy.toFixed(3)})`;
    };

    const look = (x: number) => {
      gaze = x;
      // Not a straight line: the small rise at the extremes is the surface
      // curving away underneath the face.
      face.current!.style.transform =
        `translate(${(x * 13).toFixed(2)}px,${(-2.2 * x * x).toFixed(2)}px)`;
      // The mouth covers less ground than the eyes and foreshortens less — it
      // sits nearer the centre of the sphere. That gap is the parallax, and it
      // does more work than either part alone.
      if (mouth.current) mouth.current.style.transform = `translateX(${(-x * 6.4).toFixed(2)}px)`;
      if (jaw.current) jaw.current.style.transform = `scaleX(${(1 - Math.abs(x) * 0.3).toFixed(3)})`;
      turn.current!.style.transform = `rotate(${(x * 5.5).toFixed(2)}deg)`;
      eye(socketL.current, -x);
      eye(socketR.current, x);
    };

    const blink = (pair: boolean) => {
      svg.classList.add('sm-blink');
      later(() => {
        svg.classList.remove('sm-blink');
        // Clustering is most of what separates a living blink from a metronome.
        if (pair && Math.random() < 0.26) later(() => blink(false), 120);
      }, 105);
    };

    const glance = () => {
      const r = Math.random();
      const next =
        r < 0.42 ? 0
        : r < 0.78 ? Math.random() * 1.2 - 0.6
        : (Math.random() < 0.5 ? -1 : 1) * (0.75 + Math.random() * 0.25);
      // Already there? Then don't move. That stillness is the point.
      if (Math.abs(next - gaze) > 0.05) look(next);
      later(glance, wait(1700, 6800));
    };

    // A face where only the eyes ever move is a face with a sticker for a mouth.
    // But an X that moves often stops reading as a mouth and starts reading as a
    // loading state, so this is short and rare.
    const twitch = () => {
      if (flex.current) {
        flex.current.style.transform = 'scale(1.18,0.86)';
        later(() => { if (flex.current) flex.current.style.transform = 'scale(1,1)'; }, 250);
      }
      later(twitch, wait(3800, 12000));
    };

    const jet = () => {
      svg.classList.add('sm-jet');
      later(() => svg.classList.remove('sm-jet'), 1300);
      later(jet, 9000 + Math.random() * 16000);
    };

    later(glance, wait(1700, 6800));
    later(() => { blink(true); const b = () => later(() => { blink(true); b(); }, wait(1800, 7000)); b(); }, wait(1800, 7000));
    later(twitch, wait(3800, 12000));
    later(jet, 9000 + Math.random() * 16000);

    return () => { timers.forEach(clearTimeout); timers.clear(); };
  }, [still]);

  return (
    <svg
      ref={root}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={cn('signal-mark', still && 'signal-mark--still', className)}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <g className="sm-pod">
        <g ref={turn} className="sm-turn">
          <path d={BODY_PATH} fill={BODY} />
          <g ref={face} className="sm-face">
            <g ref={socketL} className="sm-socket">
              <circle className="sm-pupil" cx="35" cy="54" r="6.8" fill={FEATURE} />
            </g>
            <g ref={socketR} className="sm-socket">
              <circle className="sm-pupil" cx="65" cy="54" r="6.8" fill={FEATURE} />
            </g>
            {/* Three nested groups so the X can travel with the turn, foreshorten
                against it, and flex on a clock of its own — all at once. */}
            <g ref={mouth} className="sm-mouth">
              <g ref={jaw} className="sm-jaw">
                <g ref={flex} className="sm-flex" stroke={FEATURE} strokeWidth="4.2" strokeLinecap="round" fill="none">
                  <line x1="44" y1="71" x2="56" y2="81" />
                  <line x1="56" y1="71" x2="44" y2="81" />
                </g>
              </g>
            </g>
          </g>
        </g>
      </g>

      <g fill={BODY}>
        <circle className="sm-spout" cx="50" cy="14" r="3.4" />
        <circle className="sm-spout sm-spout2" cx="41" cy="16" r="2.5" />
        <circle className="sm-spout sm-spout3" cx="59" cy="16" r="2.5" />
      </g>

      <style>{`
        .signal-mark { display:block; overflow:visible; }

        /* A slow, continuous turn rather than a snap. Biologically an eye
           saccades, but a mark that darts reads nervous in a sidebar you look at
           all day. The layers deliberately do NOT share a duration: parts that
           start and stop together read as one rigid object being driven by
           something. */
        .signal-mark .sm-face   { transition:transform 1150ms cubic-bezier(.42,0,.3,1); }
        .signal-mark .sm-mouth  { transition:transform 1290ms cubic-bezier(.42,0,.3,1); }
        .signal-mark .sm-jaw    { transform-box:fill-box; transform-origin:center;
                                  transition:transform 1240ms cubic-bezier(.42,0,.3,1); }
        .signal-mark .sm-turn   { transform-origin:50px 62px;
                                  transition:transform 1420ms cubic-bezier(.42,0,.28,1); }
        .signal-mark .sm-socket { transform-box:fill-box; transform-origin:center;
                                  transition:transform 1200ms cubic-bezier(.42,0,.3,1); }
        .signal-mark .sm-flex   { transform-box:fill-box; transform-origin:center;
                                  transition:transform 240ms cubic-bezier(.3,1.35,.4,1); }
        .signal-mark .sm-pupil  { transform-box:fill-box; transform-origin:center;
                                  transition:transform 90ms ease-out; }
        .signal-mark.sm-blink .sm-pupil { transform:scaleY(.06); }

        /* Never perfectly still, on a deliberately unrounded period so it cannot
           phase-lock with anything the driver does. */
        .signal-mark .sm-pod { animation:sm-bob 5.7s ease-in-out infinite; transform-origin:50px 60px; }
        @keyframes sm-bob { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-2.2px);} }

        .signal-mark .sm-spout { opacity:0; transform:translateY(4px) scale(.4); transform-origin:50px 20px; }
        .signal-mark.sm-jet .sm-spout  { animation:sm-spout 1.15s ease-out 1; }
        .signal-mark.sm-jet .sm-spout2 { animation-delay:.09s; }
        .signal-mark.sm-jet .sm-spout3 { animation-delay:.045s; }
        @keyframes sm-spout {
          0%   { opacity:0; transform:translateY(4px) scale(.4); }
          22%  { opacity:1; transform:translateY(-6px) scale(1); }
          62%  { opacity:.5; transform:translateY(-13px) scale(.8); }
          100% { opacity:0; transform:translateY(-18px) scale(.5); }
        }

        .signal-mark--still .sm-pod { animation:none; }
        @media (prefers-reduced-motion: reduce) {
          .signal-mark .sm-pod { animation:none; }
        }
      `}</style>
    </svg>
  );
}
