// The wallet in the header: a pill that opens a popover from its own corner. Not connected, it offers the
// two ways in (LLD §7 "Wallets"); connected, it shows the address, balance, free GLM and key export.
import { ChevronDown, KeyRound, Wallet as WalletIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useWallet } from "../App.tsx";
import { EXPLORER } from "../receipts.ts";
import { FAUCET, tg } from "../telegram.ts";
import {
  balance,
  canSponsor,
  connectMetaMask,
  glm,
  requestSponsor,
  storedKey,
  useLocalKey,
} from "../wallet.ts";
import { Button, cx, ErrorText, Hash, short, useLoad } from "./kit.tsx";

// The relay sponsors wallets below this (relay/sponsor.ts FUNDED).
const NEEDS_GLM = 10_000_000_000_000_000n; // 0.01 GLM

const KEY_NOTE = {
  browser:
    "This key exists only in this browser. Clearing site data deletes it, so export a copy.",
  "telegram-secure":
    "This key is in Telegram's secure storage on this phone and never leaves it.",
  "telegram-device": "This key is in Telegram's storage on this device only.",
};

const glmShort = (wei: bigint) => {
  const [n, f = ""] = glm(wei).replace(" GLM", "").split(".");
  return f ? `${n}.${f.slice(0, 3)}` : n;
};

// Opens below its trigger, scaling from the top-right corner where the trigger is (emil: origin-aware).
function Popover({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) =>
      !ref.current?.parentElement?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, onClose]);
  // Phones: the wrapper is only sm:relative, so this anchors to the sticky header and spans it.
  return (
    <div
      ref={ref}
      role="dialog"
      aria-hidden={!open}
      inert={!open}
      className={cx(
        "absolute top-full right-0 z-50 mt-2 w-[320px] origin-top-right max-sm:inset-x-3 max-sm:w-auto rounded-[18px] bg-float p-2 shadow-float transition-[opacity,transform] ease-out",
        open
          ? "scale-100 opacity-100 duration-200"
          : "pointer-events-none scale-[0.96] opacity-0 duration-150",
      )}
    >
      {children}
    </div>
  );
}

function Choice({
  icon,
  title,
  text,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-start gap-3 rounded-[12px] p-3 text-left transition-[background-color,transform] duration-150 hover:bg-fill active:scale-[0.98]"
    >
      <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-fill text-ink">
        {icon}
      </span>
      <span>
        <span className="block text-[15px] font-medium">{title}</span>
        <span className="block text-[13px] leading-[1.35] text-ink-2">
          {text}
        </span>
      </span>
    </button>
  );
}

// Any page can ask for the wallet menu ("Connect wallet" in the hero, a sign button): openWallet().
const OPEN = "prometheus:open-wallet";
export const openWallet = () => {
  scrollTo({ top: 0, behavior: "smooth" });
  dispatchEvent(new Event(OPEN));
};
function useOpenRequest(open: () => void) {
  useEffect(() => {
    addEventListener(OPEN, open);
    return () => removeEventListener(OPEN, open);
  }, [open]);
}

export function WalletMenu() {
  const { wallet: w, connect } = useWallet();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  useOpenRequest(
    useCallback(
      () => (tg ? void connect(useLocalKey) : setOpen(true)),
      [connect],
    ),
  );

  if (!w)
    return tg ? (
      // The Telegram webview has no MetaMask: one step, a key kept by Telegram.
      <Button size="sm" variant="primary" onClick={() => connect(useLocalKey)}>
        Create wallet
      </Button>
    ) : (
      <div className="sm:relative">
        <Button
          size="sm"
          variant="primary"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          Connect wallet
        </Button>
        <Popover open={open} onClose={close}>
          <Choice
            icon={<WalletIcon className="size-4" />}
            title="MetaMask"
            text="Sign with the wallet you already use. Adds the Tiramisu network if needed."
            onClick={() => connect(connectMetaMask).then((ok) => ok && close())}
          />
          <Choice
            icon={<KeyRound className="size-4" />}
            title="A key in this browser"
            text="A new key made here and kept only here. No extension needed."
            onClick={() => connect(useLocalKey).then((ok) => ok && close())}
          />
        </Popover>
      </div>
    );

  return <Connected key={w.address} />;
}

function Connected() {
  const { wallet } = useWallet();
  const w = wallet!;
  const [open, setOpen] = useState(false);
  useOpenRequest(useCallback(() => setOpen(true), []));
  const bal = useLoad(() => balance(w.address), [w.address]);
  const low = bal.data !== undefined && bal.data < NEEDS_GLM;

  return (
    <div className="sm:relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 cursor-pointer items-center gap-2 rounded-full bg-fill pr-2.5 pl-1 text-[13px] font-medium transition-[background-color,transform] duration-150 hover:bg-fill-strong active:scale-[0.97]"
      >
        <span
          className="size-6 rounded-full"
          style={{
            background: `conic-gradient(from 200deg, #${w.address.slice(2, 8)}, #${w.address.slice(-6)}, #${w.address.slice(2, 8)})`,
          }}
        />
        <span className="font-mono text-[12px]">{short(w.address)}</span>
        {low && (
          <span
            className="size-1.5 rounded-full bg-warn"
            aria-label="Needs GLM"
          />
        )}
        <ChevronDown
          className={cx(
            "size-3.5 text-ink-2 transition-transform duration-200",
            open && "rotate-180",
          )}
        />
      </button>

      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="p-3">
          <div className="text-[13px] text-ink-2">
            {w.kind === "metamask" ? "MetaMask" : "Key on this device"}
          </div>
          <Hash
            value={w.address}
            href={`${EXPLORER}/address/${w.address}`}
            className="mt-0.5"
          />
          <div className="mt-4 text-[13px] text-ink-2">Balance</div>
          <div className="tnum text-[28px] leading-tight font-semibold tracking-[-0.02em]">
            {bal.error
              ? "Unavailable"
              : bal.data === undefined
                ? "…"
                : glmShort(bal.data)}
            <span className="ml-1 text-[15px] font-medium text-ink-2">GLM</span>
          </div>
          {low && <Funding address={w.address} onFunded={bal.reload} />}
          {w.kind === "local" && (
            <>
              <p className="mt-4 text-[13px] leading-[1.4] text-ink-2">
                {KEY_NOTE[w.storage ?? "browser"]}
              </p>
              <ExportKey />
            </>
          )}
          <a
            href="#/mine"
            onClick={() => setOpen(false)}
            className="mt-3 flex h-9 items-center justify-center rounded-full bg-fill text-[13px] font-medium transition-colors hover:bg-fill-strong"
          >
            My subscriptions
          </a>
        </div>
      </Popover>
    </div>
  );
}

// Some webviews (Telegram's among them) block the clipboard: fall back to showing the key.
function ExportKey() {
  return (
    <Button
      size="sm"
      className="mt-3 w-full"
      onClick={async () => {
        const key = (await storedKey())!;
        try {
          await navigator.clipboard.writeText(key);
          toast("Private key copied", {
            description:
              "Anyone with it controls this wallet. Keep it somewhere safe.",
          });
        } catch {
          prompt(
            "Your private key. Keep it secret: anyone with it controls this wallet.",
            key,
          );
        }
      }}
    >
      <KeyRound className="size-3.5" /> Export key
    </Button>
  );
}

// An unfunded wallet can't sign anything: free GLM inside Telegram, the faucet everywhere else.
export function Funding({
  address,
  onFunded,
}: {
  address: `0x${string}`;
  onFunded: () => void;
}) {
  const [state, setState] = useState<{ sending?: boolean; error?: unknown }>(
    {},
  );
  const faucet = (
    <a href={FAUCET} target="_blank" rel="noreferrer" className="text-accent">
      the faucet
    </a>
  );
  if (!canSponsor())
    return (
      <p className="mt-2 text-[13px] leading-[1.4] text-warn">
        Signing needs GLM. Get some free from {faucet}.
      </p>
    );
  return (
    <div className="mt-3 space-y-2">
      {state.error !== undefined && <ErrorText error={state.error} />}
      <Button
        variant="primary"
        size="sm"
        className="w-full"
        disabled={state.sending}
        onClick={async () => {
          setState({ sending: true });
          try {
            await requestSponsor(address);
            setState({});
            toast.success("Free GLM received", {
              description: "You can sign subscriptions now.",
            });
            onFunded();
          } catch (error) {
            setState({ error });
          }
        }}
      >
        {state.sending ? "Sending GLM…" : "Get free GLM to start"}
      </Button>
      {state.error !== undefined && (
        <p className="text-[13px] text-ink-2">Or use {faucet}.</p>
      )}
    </div>
  );
}
