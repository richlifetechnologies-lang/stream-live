import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { AppLayout } from "../components/layout"
import { Stage, PageHead, Card, CardTitle, Stat, PrimaryButton, D2 } from "../components/d2";
import { ContactCard, PayCard, hasContact, hasPayment } from "../components/contact";
import { WatermarkOffer } from "../components/watermark-offer";
import { gateway, useAccount } from "../lib/gateway";
import { openTill, openTillInBrowser, tillOpensInApp } from "../lib/shop";
import { MOD_LABELS } from "../lib/minutes";
import { toUserMessage } from "../lib/end-reason";
import { t } from "../lib/i18n";
import { usd, type AccountSnapshot, type CheckoutInfo, type Modality, type Plan } from "@stream-live/client";
import { Clock, CreditCard, Globe, RefreshCw, Smartphone, Tag } from "lucide-react";
const MODS: Modality[] = ["video", "audio", "video_audio"];

/** The cedi figure the payment page will charge — the seller's own, not a guess. */
const ghs = (n: number) => "GH\u20B5" + n.toFixed(2);

/**
 * The two shelves. The customer picks one with his own tap and the app remembers it, so
 * nobody's network address is ever read to decide what he may buy: a Ghanaian on a VPN and
 * a visitor in Accra both land where they themselves said they pay from.
 */
type Shelf = "gh" | "intl";
const SHELF_KEY = "streamlive.market.shelf";
/** Which till window each shelf opens: mobile money at home, card abroad. */
const SHELF_WAY: Record<Shelf, "mobile_money" | "card"> = { gh: "mobile_money", intl: "card" };

/** Which shelf the seller has put a package on. Until his list says otherwise it is a Ghana
 *  package — the app never guesses a customer's market. */
function shelfOf(p: Plan): Shelf {
  return p.market === "intl" ? "intl" : "gh";
}

function rememberedShelf(): Shelf {
  try { return localStorage.getItem(SHELF_KEY) === "intl" ? "intl" : "gh"; } catch { return "gh"; }
}

/**
 * Each shelf wears its own colour from the switch down to the price, so a customer who taps
 * his way between the two lists always knows which one he is standing on. Ghana keeps the
 * app's own cyan; the shelf for users outside Ghana takes a violet that cannot be confused
 * with it. `tint` exists because an hsl colour cannot take an alpha suffix by string
 * concatenation — `hsl(187 100% 52%)66` is not CSS and the browser drops it in silence.
 */
const SHELF_ACCENT: Record<Shelf, { solid: string; text: string; tint: (a: number) => string }> = {
  gh: { solid: D2, text: "hsl(187 100% 66%)", tint: (a) => `hsl(187 100% 52% / ${a})` },
  intl: { solid: "hsl(262 85% 70%)", text: "hsl(264 95% 84%)", tint: (a) => `hsl(262 85% 70% / ${a})` },
};
const SHELF_LABEL: Record<Shelf, string> = {
  gh: "Ghana Users Package",
  intl: "Users outside Ghana Package",
};
const SHELF_WAY_LABEL: Record<Shelf, string> = {
  gh: "Paid by mobile money — MTN, Telecel or AT Money",
  intl: "Paid by card — Visa or Mastercard",
};

export default function PlansPage() {
  const account = useAccount();
  const [, setLocation] = useLocation();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [snap, setSnap] = useState<AccountSnapshot | null>(null);
  const [shop, setShop] = useState<CheckoutInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shelf, setShelf] = useState<Shelf>(rememberedShelf);

  const pickShelf = (next: Shelf) => {
    setShelf(next);
    try { localStorage.setItem(SHELF_KEY, next); } catch { /* remembering is a convenience */ }
    // The same answer is written against his account, so the next computer he signs in on
    // already knows which list he wants. It is his tap either way, never a reading of his
    // network, and a failure here costs nothing he can see.
    if (account.signedIn) void gateway.chooseMarket(next);
  };

  const load = useCallback(async () => {
    if (!account.signedIn) return;
    try {
      const [p, s, c] = await Promise.all([gateway.plans(), gateway.snapshot(), gateway.checkout()]);
      setPlans(p); setSnap(s); setShop(c); setError(null);
    } catch (e) {
      setError(toUserMessage(e, t("We couldn't load the plans. Try again in a moment.")));
    } finally {
      setLoaded(true);
    }
  }, [account.signedIn]);

  useEffect(() => { void load(); }, [load]);

  const videoWallet = snap?.wallets.find(w => w.modality === "video");
  const videoLeft = videoWallet?.unlimited ? null : Number(videoWallet?.balance ?? 0);
  // Only a package the payment service itself quotes is buyable. A card it does not
  // name keeps its price and its minutes and simply has no button, so the screen can
  // never promise a purchase the page would refuse.
  const online = shop?.enabled === true;

  /**
   * The two shelves. Every package the seller has listed today is a Ghana package. The shelf
   * for users outside Ghana carries the packages he has marked for it; until he marks any,
   * that shelf offers the same packages at the same prices so a customer abroad is not left
   * staring at an empty page. The moment he lists his own on the panel, only his show.
   *
   * `mirrored` says a card is somebody else's figure rather than one he priced: the copied
   * rows still wear the Ghana price, so the app does not tell a buyer on this shelf that the
   * package is HIS. A twin stops counting as copied the second he types his own price.
   */
  type Listed = { plan: Plan; mirrored: boolean };
  const byId = new Map(plans.map((p) => [p.id, p]));
  const ghPlans: Listed[] = plans.filter((p) => shelfOf(p) === "gh").map((plan) => ({ plan, mirrored: false }));
  const marked = plans.filter((p) => shelfOf(p) === "intl");
  const intlPlans: Listed[] = (marked.length ? marked : ghPlans.map((c) => c.plan)).map((plan) => ({
    plan,
    mirrored: marked.length
      ? plan.mirrorOf !== null && byId.get(plan.mirrorOf)?.priceCents === plan.priceCents
      : true,
  }));

  /** The lowest price that shelf can actually take money for. */
  const fromPrice = (list: Listed[]) => {
    if (!online) return null;
    const cents = list.map(c => shop!.prices[c.plan.id]).filter((n): n is number => Number.isFinite(n))
      .sort((a, b) => a - b);
    return cents.length ? ghs(cents[0]) : null;
  };

  /** One half of the shelf switch: what it is, how it is paid for, how many packages are on
   *  it and the cheapest figure it can take money for. Both halves stay in their own colour
   *  even when the other one is open — he asked for the two lists to be seen the moment the
   *  page opens, not discovered by tapping. A call, not a component, so the page keeps its
   *  DOM identity while it re-renders. */
  const ShelfPill = (id: Shelf, list: Listed[]) => {
    const on = shelf === id;
    const a = SHELF_ACCENT[id];
    const from = fromPrice(list);
    const Icon = id === "gh" ? Smartphone : Globe;
    return (
      <button key={id} onClick={() => pickShelf(id)} aria-pressed={on} style={{
        display: "flex", alignItems: "center", gap: 12, width: "100%", minWidth: 0, textAlign: "left",
        padding: on ? "14px 16px" : "13px 16px", borderRadius: 12, cursor: "pointer",
        transition: "background .18s ease, box-shadow .18s ease, border-color .18s ease",
        background: on
          ? `linear-gradient(135deg, ${a.tint(0.28)} 0%, ${a.tint(0.07)} 100%)`
          : a.tint(0.07),
        border: `1px solid ${a.tint(on ? 0.72 : 0.34)}`,
        boxShadow: on ? `0 0 30px ${a.tint(0.26)}` : "none",
      }}>
        <span style={{
          width: 36, height: 36, borderRadius: 11, flexShrink: 0, display: "flex",
          alignItems: "center", justifyContent: "center",
          background: on ? a.solid : a.tint(0.18),
          color: on ? "hsl(222 47% 5%)" : a.text,
          boxShadow: on ? `0 0 24px ${a.tint(0.55)}` : "none",
        }}>
          <Icon style={{ width: 19, height: 19 }} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: "block", fontFamily: "'Orbitron',monospace", fontWeight: 800, fontSize: on ? 15 : 13.5, letterSpacing: "0.07em", textTransform: "uppercase", color: a.text }}>
            {t(SHELF_LABEL[id])}
          </span>
          <span style={{ display: "block", fontSize: 12, color: on ? "hsl(190 40% 88%)" : "hsl(222 25% 58%)", fontFamily: "'Rajdhani',sans-serif", marginTop: 4 }}>
            {t(SHELF_WAY_LABEL[id])}{t(" · {n} on this shelf", { n: list.length })}{from ? t(" · from {price}", { price: from }) : ""}
          </span>
        </span>
        {on && <span style={{ width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: a.solid, boxShadow: `0 0 14px ${a.solid}` }} />}
      </button>
    );
  };

  if (!account.signedIn) {
    return (
      <AppLayout>
        <Stage>
          <PageHead
            name="Plans and prices"
            note="Sign in to see the packages your administrator sells and how to reach them."
          />
          <Card style={{ maxWidth: 620, margin: "0 auto", textAlign: "center" }} pad={28}>
            <PrimaryButton onClick={() => setLocation("/account")} style={{ margin: "0 auto" }}>
              {t("Sign in")}
            </PrimaryButton>
          </Card>
        </Stage>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <Stage>
      <div style={{ padding: "0 0 40px", maxWidth: 980, margin: "0 auto" }}>
        {snap && (
          <WatermarkOffer
            paid={snap.paid}
            videoMinutesLeft={videoLeft}
            ctaLabel="Ask for the top-up"
            ctaHref="/minutes"
          />
        )}

        <PageHead
          name="Choose Your Plan"
          note="Choose the list that matches where you pay from, then pick the package that works best for you."
          pills={
            <button onClick={() => void load()}
              style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 12, padding: "8px 15px", borderRadius: 999, cursor: "pointer", background: "hsl(228 62% 4% / 0.7)", border: `1px solid ${D2}55`, color: D2, fontSize: 11, fontWeight: 800, fontFamily: "'Orbitron',monospace", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              <RefreshCw style={{ width: 12, height: 12 }} /> {t("Refresh")}
            </button>
          }
          card={videoWallet ? (
            <Card>
              <Stat
                label={t("Minutes available")}
                value={videoWallet.unlimited ? t("UNLIMITED") : t("{n} min", { n: (videoLeft ?? 0).toLocaleString("en-US") })}
                accent={D2}
                sub={t("Minutes never expire")}
              />
            </Card>
          ) : undefined}
        />

        {error && (
          <div style={{ marginBottom: 14, padding: "11px 15px", borderRadius: 10, background: "hsl(0 85% 40% / 0.12)", border: "1px solid hsl(0 85% 40% / 0.3)", color: "hsl(0 85% 70%)", fontSize: 13, fontFamily: "'Rajdhani',sans-serif" }}>
            {error}
          </div>
        )}

        {loaded && plans.length === 0 && !error && (
          <Card style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "hsl(222 25% 55%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
              {t("No packages are listed yet. Ask your administrator what minutes are available.")}
            </p>
          </Card>
        )}

        {/* ── The till gate ─────────────────────────────────────────────────────
            One switch, two shelves, and the list underneath changes with the tap — no
            reload, no page to walk back from. The customer says with his own finger where
            he is paying from; nothing here reads his address or his VPN for him. The answer
            is remembered on this machine and written against his account, so the next window
            he opens starts where he left it, and the Buy button on the shelf he chose opens
            the payment window set to the one method that shelf can actually take. */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: 6,
          padding: 6, borderRadius: 14, background: "hsl(228 62% 4% / 0.7)",
          border: "1px solid hsl(222 40% 13%)", marginBottom: 10,
        }}>
          {ShelfPill("gh", ghPlans)}
          {ShelfPill("intl", intlPlans)}
        </div>
        <p style={{ fontSize: 11.5, color: "hsl(222 25% 50%)", fontFamily: "'Rajdhani',sans-serif", margin: "0 0 16" }}>
          {t("Tap the list you want to see. The app remembers this computer's answer, and you can switch at any time.")}
        </p>

        {shelf === "intl" && intlPlans.length === 0 && (
          <Card style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 13, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
              {t("No packages are listed for users outside Ghana yet. Your administrator adds them the same way as the Ghana ones, and they appear here by themselves.")}{" "}
              <button onClick={() => pickShelf("gh")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: D2, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>
                {t("See the Ghana Users Package instead")}
              </button>
            </p>
          </Card>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 16 }}>
          {(shelf === "gh" ? ghPlans : intlPlans).map(c => {
            const p = c.plan;
            const acc = SHELF_ACCENT[shelf];
            const mirrored = c.mirrored;
            const mine = !mirrored && snap?.planId === p.id;
            const mins = MODS.filter(m => p.minutes[m] > 0);
            const buyable = online ? shop!.prices[p.id] : undefined;
            return (
              <Card key={p.id} style={{
                display: "flex", flexDirection: "column", minWidth: 0,
                border: `1px solid ${acc.tint(mine ? 0.5 : 0.24)}`,
                boxShadow: `0 12px 40px hsl(226 80% 2% / 0.55), 0 0 26px ${acc.tint(0.1)}`,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <CardTitle accent={acc.solid}>{p.name}</CardTitle>
                  {mine && <span style={{ fontSize: 9.5, fontWeight: 700, color: acc.solid, background: acc.tint(0.1), border: `1px solid ${acc.tint(0.4)}`, borderRadius: 999, padding: "3px 8px", fontFamily: "'Orbitron',monospace", whiteSpace: "nowrap" }}>{t("YOUR PLAN")}</span>}
                </div>
                {/* The price is the biggest thing on the card: it is the question the customer
                    came here to answer. Nothing else sits in this row — he asked for a card
                    with the price, the minutes and the button, and no marketing text. */}
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 50%)", margin: "0 0 5px" }}>
                    {t("Price")}
                  </p>
                  <p style={{ fontFamily: "'Orbitron',monospace", fontWeight: 700, fontSize: 30, lineHeight: 1.05, margin: 0, color: acc.solid, fontVariantNumeric: "tabular-nums", wordBreak: "break-word" }}>
                    {buyable !== undefined ? ghs(buyable) : usd(p.priceCents)}
                  </p>
                  {buyable === undefined && (
                    <p style={{ fontSize: 11, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", margin: "5px 0 0", lineHeight: 1.45 }}>
                      {t("Ask your administrator for the price")}
                    </p>
                  )}
                </div>

                {mins.length > 0 && (
                  <div style={{ background: acc.tint(0.06), border: `1px solid ${acc.tint(0.22)}`, borderRadius: 10, padding: "10px 12px", marginTop: 12 }}>
                    <p style={{ fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: "'Orbitron',monospace", color: "hsl(222 25% 50%)", margin: "0 0 7px" }}>{t("Minutes in this package")}</p>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10 }}>
                      {mins.map(m => (
                        <Stat
                          key={m}
                          label={MOD_LABELS[m]}
                          value={
                            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
                              <Clock style={{ width: 11, height: 11, color: acc.solid, flexShrink: 0 }} />
                              {t("{n} min", { n: p.minutes[m].toLocaleString("en-US") })}
                            </span>
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {buyable !== undefined && (
                  <PrimaryButton onClick={() => openTill(shop!.page, SHELF_WAY[shelf], shelf)} style={{ marginTop: 12, alignSelf: "stretch", ...(shelf === "intl" ? { background: `linear-gradient(135deg, ${acc.solid} 0%, hsl(258 85% 58%) 100%)`, boxShadow: `0 0 26px ${acc.tint(0.3)}` } : {}) }}>
                    {shelf === "gh" ? <Smartphone style={{ width: 14, height: 14 }} /> : <CreditCard style={{ width: 14, height: 14 }} />} {t("Buy — {price}", { price: ghs(buyable) })}
                  </PrimaryButton>
                )}
              </Card>
            );
          })}
        </div>

        {snap && (hasPayment(snap.pay) || hasContact(snap.contact)) ? (
          <>
            <PayCard pay={snap.pay} title={online ? t("Or pay the administrator directly") : t("Pay the administrator — MoMo or Bitcoin only")} />
            <ContactCard contact={snap.contact} title={t("After paying, tell the administrator")} />
          </>
        ) : (
            <Card style={{ border: "1px solid hsl(35 100% 55% / 0.32)" }}>
              <CardTitle accent="hsl(35 100% 62%)"><Tag style={{ width: 11, height: 11, verticalAlign: -1, marginRight: 6 }} />{t("No payment details yet")}</CardTitle>
              <p style={{ fontSize: 13, color: "hsl(222 25% 60%)", fontFamily: "'Rajdhani',sans-serif", margin: 0 }}>
                {t("Your administrator has not published a MoMo number, Bitcoin address or contact handle yet. Send a request from the")}{" "}
                <button onClick={() => setLocation("/minutes")} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", color: D2, fontSize: 13, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>{t("Minutes page")}</button>{" "}
                {t("and they will see it in their panel.")}
              </p>
            </Card>
          )}

        <Card style={{ background: "transparent", border: "1px dashed hsl(222 40% 14%)", boxShadow: "none" }}>
          <p style={{ fontSize: 12, color: "hsl(222 25% 48%)", fontFamily: "'Rajdhani',sans-serif", margin: 0, lineHeight: 1.6 }}>
            {online
              ? t("Buying on this screen opens the payment window right here in the app — you choose the package and type your email, then the payment page takes the card or mobile money on its own screen. That window carries nothing of yours: no sign-in, no camera, no microphone, and it leaves nothing behind on the computer when it closes. The minutes land the moment the payment clears, and they never expire. Prices and minutes are set by your administrator.")
              : t("The minutes above land in your account when your administrator confirms the payment, and they never expire. Prices and minutes are set by them — Stream Live takes no card details, charges nothing inside the app, and there is no trial balance.")}
          </p>
          {online && tillOpensInApp() && (
            <button onClick={() => openTillInBrowser(shop!.page)}
              style={{ background: "none", border: "none", padding: 0, marginTop: 8, cursor: "pointer", color: "hsl(222 25% 55%)", fontSize: 12, fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline", textAlign: "left" }}>
              {t("Open the payment page in my browser instead")}
            </button>
          )}
        </Card>
      </div>
      </Stage>
    </AppLayout>
  );
}
