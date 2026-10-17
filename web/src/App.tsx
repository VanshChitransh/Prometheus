// The shell: one hash-routed bundle (LLD §1) that is both the website (home, docs, blog, coverage) and
// the app (watch, status, subscriptions). The header changes with it: site pages get the site nav and
// the wallet; app pages also get a tab bar on phones. The wallet lives in a context.
import {
  Activity,
  House,
  ListChecks,
  Menu,
  PlusCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentType,
} from "react";
import { Toaster } from "sonner";
import { Blog, BlogPost } from "./pages/Blog.tsx";
import { Coverage } from "./pages/Coverage.tsx";
import { Docs } from "./pages/Docs.tsx";
import { Home } from "./pages/Home.tsx";
import { Mine } from "./pages/Mine.tsx";
import { New } from "./pages/New.tsx";
import { Status } from "./pages/Status.tsx";
import { tg } from "./telegram.ts";
import { AskPanel } from "./ui/AskPanel.tsx";
import { cx, ErrorText, LinkButton, Spark } from "./ui/kit.tsx";
import { VoxelWord } from "./ui/VoxelWord.tsx";
import { WalletMenu } from "./ui/WalletMenu.tsx";
import { wallet, type Wallet } from "./wallet.ts";

type WalletCtx = {
  wallet?: Wallet;
  connect: (get: () => Wallet | Promise<Wallet>) => Promise<boolean>;
};
const Ctx = createContext<WalletCtx>({ connect: async () => false });
export const useWallet = () => useContext(Ctx);

type Layout = "full" | "wide" | "app";
// Regex captures become the page's params. #/new/<key>/<trigger> opens the form filled in.
const ROUTES: [RegExp, ComponentType<{ params: string[] }>, Layout][] = [
  [/^\/$/, Home, "full"],
  [/^\/docs(?:\/([a-z0-9-]+))?\/?$/, Docs, "wide"],
  [/^\/blog\/?$/, Blog, "app"],
  [/^\/blog\/([a-z0-9-]+)$/, BlogPost, "app"],
  [
    /^\/new(?:\/(0x[0-9a-fA-F]{64}))?(?:\/(expiring|expired|changed|keep|new_match))?$/,
    New,
    "app",
  ],
  [/^\/s\/(0x[0-9a-fA-F]{64})$/, Status, "app"],
  [/^\/coverage$/, Coverage, "app"],
  [/^\/mine$/, Mine, "app"],
];

// One nav everywhere. "Watch" is the app (create a subscription); your subscriptions are in the
// wallet menu.
const NAV: [string, string][] = [
  ["#/new", "Watch"],
  ["#/docs", "Docs"],
  ["#/docs/sdk", "SDK"],
  ["#/blog", "Blog"],
  ["#/coverage", "Activity"],
];
const APP_NAV: [string, string, LucideIcon][] = [
  ["#/", "Home", House],
  ["#/new", "New", PlusCircle],
  ["#/mine", "Subscriptions", ListChecks],
  ["#/coverage", "Activity", Activity],
];

const hashPath = () => location.hash.slice(1) || "/";
const isAppPage = (path: string) => /^\/(new|s\/|mine)/.test(path);

// The theme index.html / telegram.ts set, so Sonner's toasts match it.
function useTheme() {
  const read = (): "dark" | "light" =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [t, set] = useState(read);
  useEffect(() => {
    const mo = new MutationObserver(() => set(read()));
    mo.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => mo.disconnect();
  }, []);
  return t;
}

export function App() {
  const [path, setPath] = useState(hashPath);
  const [w, setW] = useState(wallet);
  const [error, setError] = useState<unknown>();
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState(false);
  const theme = useTheme();

  useEffect(() => {
    const onHash = () => {
      setPath(hashPath());
      setMenu(false);
      scrollTo(0, 0);
    };
    const onScroll = () => setScrolled(scrollY > 4);
    addEventListener("hashchange", onHash);
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("scroll", onScroll);
    };
  }, []);

  const connect = async (get: () => Wallet | Promise<Wallet>) => {
    setError(undefined);
    try {
      setW(await get());
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  };

  let page = <NotFound />;
  let layout: Layout = "app";
  for (const [re, P, l] of ROUTES) {
    const m = re.exec(path);
    // key: a fresh page per route, so a slow load from the last page can't land on this one.
    if (m) {
      page = <P key={path} params={m.slice(1)} />;
      layout = l;
      break;
    }
  }
  const app = !!tg || isAppPage(path); // inside Telegram it is always the app
  const current = (href: string) => {
    const p = href.slice(1);
    if (p === "/") return path === "/";
    // "Docs" lights for any docs page except the SDK's, which has its own item.
    if (p === "/docs") return path.startsWith("/docs") && path !== "/docs/sdk";
    return (
      path === p ||
      path.startsWith(`${p}/`) ||
      (p === "/mine" && path.startsWith("/s/"))
    );
  };

  return (
    <Ctx.Provider value={{ wallet: w, connect }}>
      <div className="flex min-h-dvh flex-col">
        <header
          className={cx(
            "sticky top-0 z-40 bg-chrome pt-[env(safe-area-inset-top)] backdrop-blur-xl backdrop-saturate-150 transition-shadow duration-200",
            (scrolled || layout !== "full") && "shadow-[0_1px_0_var(--sep)]",
          )}
        >
          <div className="mx-auto flex h-15 max-w-[1200px] items-center gap-4 px-5 sm:px-10 md:gap-8">
            <a
              href="#/"
              className="flex items-center gap-2 text-[17px] font-semibold tracking-[-0.02em]"
            >
              <Spark className="size-[18px] text-accent" />
              Prometheus
            </a>
            <nav
              className="hidden items-center gap-7 md:flex"
              aria-label="Main"
            >
              {NAV.map(([href, text]) => (
                <a
                  key={href}
                  href={href}
                  aria-current={current(href) ? "page" : undefined}
                  className={cx(
                    "text-[14px] transition-colors duration-150",
                    current(href)
                      ? "font-medium text-ink"
                      : "text-ink-2 hover:text-ink",
                  )}
                >
                  {text}
                </a>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <WalletMenu />
              {!tg && (
                <button
                  type="button"
                  aria-label={menu ? "Close menu" : "Menu"}
                  aria-expanded={menu}
                  onClick={() => setMenu(!menu)}
                  className="grid size-9 cursor-pointer place-items-center rounded-full text-ink transition-colors hover:bg-fill md:hidden"
                >
                  {menu ? (
                    <X className="size-5" />
                  ) : (
                    <Menu className="size-5" />
                  )}
                </button>
              )}
            </div>
          </div>
          {/* phones: the nav as a sheet under the header */}
          {!tg && menu && (
            <nav
              className="border-t border-sep px-5 pt-2 pb-5 md:hidden"
              aria-label="Main"
            >
              {[...NAV, ["#/mine", "My subscriptions"] as [string, string]].map(
                ([href, text]) => (
                  <a
                    key={href}
                    href={href}
                    className="block border-b border-sep py-3.5 text-[17px] last:border-b-0"
                  >
                    {text}
                  </a>
                ),
              )}
            </nav>
          )}
        </header>

        {error !== undefined && (
          <div className="mx-auto w-full max-w-[1040px] px-5 pt-4">
            <ErrorText error={error} />
          </div>
        )}

        <main
          className={cx(
            "w-full flex-1",
            layout === "full" && "pb-0",
            layout === "wide" &&
              "mx-auto max-w-[1200px] px-5 pt-10 pb-24 sm:px-10 sm:pt-14",
            layout === "app" &&
              "mx-auto max-w-[1040px] px-5 pt-10 pb-32 sm:pt-14 sm:pb-24",
          )}
        >
          {page}
          {/* Outside the keyed page: the conversation survives moving between docs pages (cited links). */}
          {path.startsWith("/docs") && <AskPanel />}
        </main>

        {!tg && <Footer />}
        {app && <TabBar current={current} />}
      </div>
      <Toaster theme={theme} position="top-center" offset={72} />
    </Ctx.Provider>
  );
}

const FOOTER: [string, string][] = [
  ["#/docs", "Docs"],
  ["#/docs/sdk", "SDK"],
  ["#/blog", "Blog"],
  ["#/coverage", "Activity"],
  ["#/docs/run-a-worker", "Run a worker"],
  ["https://github.com/VanshChitransh/Prometheus", "GitHub"],
];

function Footer() {
  return (
    <footer className="overflow-hidden">
      <div className="flex flex-col items-center px-5 pt-24 text-center">
        <a href="#/" aria-label="Prometheus home">
          <Spark className="size-14 text-accent" />
        </a>
        <ul className="mt-8 flex flex-wrap justify-center gap-x-7 gap-y-2 text-[15px]">
          {FOOTER.map(([href, text]) => (
            <li key={href}>
              <a
                href={href}
                {...(/^https?:/.test(href) && {
                  target: "_blank",
                  rel: "noreferrer",
                })}
                className="text-ink-2 transition-colors hover:text-ink"
              >
                {text}
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-[13px] text-ink-3">
          MIT licensed. Built on Arkiv's Tiramisu testnet.
        </p>
      </div>
      {/* The wordmark runs off the bottom edge; the negative margin (a % of width) crops half a row: the pixel letters need their bottom row to stay legible. */}
      <VoxelWord
        word="PROMETHEUS"
        className="mt-16 -mb-[0.9%] block w-full px-2 sm:px-4"
      />
    </footer>
  );
}

// Phones, app pages: a floating bar of icons; the current one opens to show its name (bencho tab-bar).
function TabBar({ current }: { current: (href: string) => boolean }) {
  return (
    <nav
      aria-label="App"
      className="fixed inset-x-0 bottom-[calc(12px+env(safe-area-inset-bottom))] z-40 flex justify-center sm:hidden"
    >
      <div className="flex items-center gap-1 rounded-full bg-chrome p-1.5 shadow-float backdrop-blur-xl backdrop-saturate-150">
        {APP_NAV.map(([href, text, Icon]) => {
          const on = current(href);
          return (
            <a
              key={href}
              href={href}
              aria-label={text}
              aria-current={on ? "page" : undefined}
              className={cx(
                "flex h-11 items-center gap-2 rounded-full px-3 text-[13px] font-medium transition-[background-color,color] duration-240 ease-out active:scale-95",
                on ? "bg-fill-strong pr-4 text-ink" : "text-ink-2",
              )}
            >
              <Icon
                className="size-[19px] shrink-0"
                strokeWidth={on ? 2.2 : 1.8}
              />
              {on && <span>{text}</span>}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function NotFound() {
  return (
    <div className="py-24">
      <h1 className="font-display text-[34px] font-medium tracking-[-0.02em]">
        There's no page here
      </h1>
      <p className="mt-2 text-ink-2">
        The link may be incomplete.{" "}
        <a href="#/" className="text-accent">
          Go to the start
        </a>
      </p>
    </div>
  );
}
