import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import type { AdminContact } from "@stream-live/client";
import { ContactLine } from "./contact";
import { IS_MAC } from "../lib/platform";

const C = "hsl(187 100% 52%)";

/** Windows ships a camera driver; a Mac takes the picture out of OBS instead. */
const CAM = IS_MAC ? "OBS Virtual Camera" : "Stream Live Camera";

/**
 * The one place that remembers a machine has been walked through, so a returning
 * customer is not walked through again but can ask for it from Settings.
 */
const TOUR_SEEN = "ss_tour_seen";

export function tourSeen(): boolean {
  try { return localStorage.getItem(TOUR_SEEN) === "1"; } catch { return false; }
}

function markTourSeen(): void {
  try { localStorage.setItem(TOUR_SEEN, "1"); } catch { /**/ }
}

const watchers = new Set<() => void>();

/**
 * Ask for the walk-through again, from any page: this machine forgets that it has seen
 * it, and the stream screen — which is the only page holding the panels to point at —
 * opens it on arrival, or right now if it happens to be on screen already.
 */
export function requestTour(): void {
  try { localStorage.removeItem(TOUR_SEEN); } catch { /**/ }
  watchers.forEach((w) => w());
}

/** A Settings label has to change when the tour is replayed, so the flag is a store. */

/** The stream screen listens for that request. Returns its own unsubscribe. */
export function onTourRequested(cb: () => void): () => void {
  watchers.add(cb);
  return () => { watchers.delete(cb); };
}

/** A Settings label has to change when the tour is replayed, so the flag is a store. */
export function useTourSeen(): boolean {
  const [seen, setSeen] = useState(tourSeen);
  useEffect(() => {
    const w = () => setSeen(tourSeen());
    watchers.add(w);
    return () => { watchers.delete(w); };
  }, []);
  return seen;
}

export type TourTab = "video-audio" | "audio-only" | "video-only";

/**
 * One stop of the walk-through.
 *
 * `anchor` names a panel marked with data-tour on the stream screen. A walk-through that
 * moved between the three tabs turned into a tour of a call type the customer had not
 * chosen, so it stays on the one tab a new account can actually use — the tab the free
 * minute funds — and the page is moved there before the first card shows. A panel that
 * isn't on screen shows the card in the middle rather than a ring around nothing.
 */
export type TourStop = {
  tab: TourTab;
  anchor: string;
  title: string;
  body: string;
};

/** The tab a new account is walked through: the one the free video minute is spent on. */
export const TOUR_TAB: TourTab = "video-only";

/** The walk-through, in the order a first call is actually set up. */
export const TOUR_STOPS: TourStop[] = [
  {
    tab: TOUR_TAB, anchor: "screen", title: "Video Call: the AI picture, your own voice",
    body: "This tab sends the picture the AI draws of you, and your normal voice — nothing about how you sound is changed or set up here. What the other person sees is drawn in this window, live, before anybody calls you. The other two tabs are the same picture or the same voice with an AI voice added, and you can try them whenever you like. Nothing is counted while you are only looking at it.",
  },
  {
    tab: TOUR_TAB, anchor: "camera", title: "Point your own camera at yourself",
    body: "Choose your real webcam in the Camera box. Do not pick " + CAM + " here — the AI has to see you to draw you. If the list is empty, allow Stream Live to use your camera in your computer's privacy settings.",
  },
  {
    tab: TOUR_TAB, anchor: "style", title: "Choose what you look like",
    body: "One tap redraws you in that style. The box below it takes your own description in words. You can change the look during a call and it updates without hanging up.",
  },
  {
    tab: TOUR_TAB, anchor: "ref", title: "One photo makes it look like you",
    body: "Optional, and worth the ten seconds. Upload a clear front-facing photo and the AI keeps your features instead of inventing somebody else's.",
  },
  {
    // The free minute is a video minute, so this is the tab that actually carries it —
    // and the only stop that appears for an account still holding one.
    tab: TOUR_TAB, anchor: "trial", title: "Your free minute is still waiting",
    body: "The minute that came with your account does not run out and does not have to be used today — it sits here until you press Start. Using it leaves a small mark on the AI picture; once your administrator adds minutes, the mark is gone.",
  },
  {
    tab: TOUR_TAB, anchor: "broadcast", title: "How the picture gets into your call",
    body: IS_MAC
      ? "In your call app choose " + CAM + " as the camera, and leave its microphone on your own device — this tab sends your real voice, so there is nothing to route. Settings has these steps with the free helper to install."
      : "Turn this panel's camera switch on, then in your call app choose " + CAM + " as the camera and leave its microphone on your own device. Nothing else in the call app needs changing.",
  },
  {
    tab: TOUR_TAB, anchor: "start", title: "Start, then join your call",
    body: "Press Start and wait until the picture in that window is moving — that is the moment your minutes begin counting, and nothing is charged before it. Press Stop here when you are finished, and the meter above the button always shows what you have left.",
  },
];

/** Stops this account should actually see: the free-minute card only exists to point at. */
export function tourStops(showTrial: boolean): TourStop[] {
  return showTrial ? TOUR_STOPS : TOUR_STOPS.filter(s => s.anchor !== "trial");
}

type Box = { left: number; top: number; width: number; height: number };

/** The panel this stop explains, in window coordinates — or nothing to explain. */
function findBox(anchor: string): Box | null {
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  // A panel that exists below the fold still gets its ring: bring it up, then measure
  // the new position rather than the one that scrolled away.
  if (r.top < 8 || r.bottom > window.innerHeight - 8) {
    (el as HTMLElement).scrollIntoView({ block: "center" });
    const after = (el as HTMLElement).getBoundingClientRect();
    if (after.height < 4) return null;
    return { left: after.left, top: after.top, width: after.width, height: after.height };
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export function GuidedTour({ stops, tab, onTab, contact, onClose }: {
  stops: TourStop[];
  tab: TourTab;
  onTab: (t: TourTab) => void;
  contact: AdminContact | null;
  onClose: () => void;
}) {
  const [i, setI] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardTop, setCardTop] = useState(24);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const stop = stops[Math.min(i, stops.length - 1)];
  const last = i === stops.length - 1;
  const cardW = Math.min(430, window.innerWidth - 32);

  // A stop on another tab moves the page there first; the panel appears a moment later.
  useEffect(() => {
    if (stop && stop.tab !== tab) onTab(stop.tab);
  }, [stop, tab, onTab]);

  useEffect(() => {
    if (!stop) return;
    let raf = 0;
    let tries = 0;
    const locate = () => {
      const b = findBox(stop.anchor);
      if (b || tries >= 20) { setBox(b); return; }
      tries++;
      raf = requestAnimationFrame(locate);
    };
    const t = setTimeout(locate, 40);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [stop]);

  // Resizing the window or scrolling the page must not leave the ring on the wrong panel.
  useEffect(() => {
    if (!stop) return;
    const rebinding = () => setBox(findBox(stop.anchor));
    window.addEventListener("resize", rebinding);
    window.addEventListener("scroll", rebinding, true);
    return () => {
      window.removeEventListener("resize", rebinding);
      window.removeEventListener("scroll", rebinding, true);
    };
  }, [stop]);

  // Under the panel if it fits there, above it if not, in the middle if there is no panel.
  useLayoutEffect(() => {
    const h = cardRef.current?.offsetHeight ?? 220;
    if (!box) { setCardTop(Math.max(20, (window.innerHeight - h) / 2)); return; }
    const below = box.top + box.height + 16;
    if (below + h <= window.innerHeight - 12) { setCardTop(below); return; }
    const above = box.top - h - 16;
    setCardTop(above >= 12 ? above : Math.max(20, (window.innerHeight - h) / 2));
  }, [box, stop]);

  const done = () => { markTourSeen(); onClose(); };
  const next = () => { if (last) done(); else setI(n => n + 1); };
  const back = () => setI(n => Math.max(0, n - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") done();
      else if (e.key === "ArrowRight" || e.key === "Enter") next();
      else if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!stop) return null;

  const pad = 6;
  const cardLeft = box
    ? Math.min(Math.max(16, box.left + box.width / 2 - cardW / 2), Math.max(16, window.innerWidth - cardW - 16))
    : Math.max(16, (window.innerWidth - cardW) / 2);

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 7000 }}>
      {/* Clicking anywhere outside the card ends the walk-through — it must never trap
          a customer who already knows how to use the app. */}
      <div onClick={done} style={{ position: "absolute", inset: 0, cursor: "default" }} />
      {box && (
        <div style={{
          position: "absolute",
          left: box.left - pad, top: box.top - pad,
          width: box.width + pad * 2, height: box.height + pad * 2,
          borderRadius: 16, border: `1.5px solid ${C}`, pointerEvents: "none",
          boxShadow: `0 0 0 10000px hsl(222 47% 4% / 0.8), 0 0 30px ${C}55`,
          transition: "all 0.22s ease",
        }} />
      )}
      {!box && (
        <div style={{ position: "absolute", inset: 0, background: "hsl(222 47% 4% / 0.86)", backdropFilter: "blur(2px)" }} />
      )}

      <div ref={cardRef} style={{
        position: "absolute", left: cardLeft, top: cardTop, width: cardW,
        padding: "20px 22px", borderRadius: 18,
        background: "hsl(222 44% 7%)", border: "1px solid hsl(187 100% 52% / 0.35)",
        boxShadow: "0 24px 60px hsl(226 80% 2% / 0.7)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "'Orbitron',monospace", color: C }}>
            {`Step ${i + 1} of ${stops.length}`}
          </span>
          <button onClick={done} title="That's enough, I know how to use it"
            style={{ background: "none", border: "none", cursor: "pointer", color: "hsl(222 25% 45%)", display: "flex", padding: 2 }}>
            <X style={{ width: 15, height: 15 }} />
          </button>
        </div>

        <h3 style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 15, color: "hsl(190 80% 96%)", marginBottom: 8, lineHeight: 1.35 }}>
          {stop.title}
        </h3>
        <p style={{ fontSize: 13, color: "hsl(222 25% 66%)", fontFamily: "'Rajdhani',sans-serif", lineHeight: 1.6, margin: 0 }}>
          {stop.body}
        </p>

        {/* The walk-through ends where a stuck customer needs to be pointed. */}
        {last && (contact?.whatsapp || contact?.telegram) && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px dashed hsl(222 40% 16%)" }}>
            <ContactLine contact={contact} note="Anything that doesn't work, tell your administrator:" />
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>
          <button onClick={back} disabled={i === 0}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 9, cursor: i === 0 ? "default" : "pointer", background: "transparent", border: "1px solid hsl(222 40% 16%)", color: i === 0 ? "hsl(222 25% 30%)" : "hsl(222 25% 65%)", fontWeight: 700, fontSize: 12.5, fontFamily: "'Rajdhani',sans-serif" }}>
            <ArrowLeft style={{ width: 13, height: 13 }} /> Back
          </button>
          <div style={{ flex: 1, display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
            {stops.map((_, n) => (
              <span key={n} style={{ width: n === i ? 14 : 5, height: 5, borderRadius: 3, background: n === i ? C : "hsl(222 40% 18%)" }} />
            ))}
          </div>
          <button onClick={next}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 9, cursor: "pointer", background: C, border: "none", color: "hsl(222 47% 4%)", fontWeight: 700, fontSize: 12.5, fontFamily: "'Rajdhani',sans-serif" }}>
            {last ? <><Check style={{ width: 13, height: 13 }} /> Got it</> : <>Next <ArrowRight style={{ width: 13, height: 13 }} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
