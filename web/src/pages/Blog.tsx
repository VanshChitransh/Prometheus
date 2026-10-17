// #/blog and #/blog/:slug: posts from web/blog/*.md, newest first. A plain dated list, like the docs it
// links back to.
import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { formatDate, POSTS, postBySlug, render } from "../content.ts";
import { LinkButton } from "../ui/kit.tsx";

declare const __BOT_NAME__: string; // vite.config.ts

export function Blog() {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">
        Blog
      </div>
      <h1 className="mt-3 font-display text-[clamp(32px,11vw,44px)] leading-[1.08] font-medium tracking-[-0.02em]">
        Notes from building Prometheus
      </h1>
      <p className="mt-3 text-[18px] text-ink-2">
        What we learned about Arkiv, expiry and proving that an alert really
        went out.
      </p>
      {!POSTS.length ? (
        <p className="mt-12 text-ink-2">The first posts are on their way.</p>
      ) : (
        <ul className="mt-12 border-t border-sep">
          {POSTS.map((p) => (
            <li key={p.slug} className="border-b border-sep">
              <a href={`#/blog/${p.slug}`} className="group block py-8">
                <div className="tnum text-[13px] text-ink-3">
                  {formatDate(p.date)}, {p.minutes} min read
                </div>
                <h2 className="mt-2 font-display text-[28px] leading-[1.2] font-medium tracking-[-0.015em] transition-colors group-hover:text-accent">
                  {p.title}
                </h2>
                {p.dek && (
                  <p className="mt-2 max-w-[62ch] text-ink-2">{p.dek}</p>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function BlogPost({ params: [slug] }: { params: string[] }) {
  const post = postBySlug(slug);
  const html = useMemo(() => (post ? render(post.body).html : ""), [post]);
  if (!post)
    return (
      <div className="mx-auto max-w-[760px]">
        <p className="text-ink-2">
          There's no post here.{" "}
          <a href="#/blog" className="text-accent">
            See all posts
          </a>
        </p>
      </div>
    );
  const bot = __BOT_NAME__ || "prometheus_arkiv_bot";
  return (
    <article className="mx-auto max-w-[720px]">
      <a
        href="#/blog"
        className="inline-flex items-center gap-1.5 text-[13px] text-ink-2 transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" /> All posts
      </a>
      <h1 className="mt-6 font-display text-[40px] leading-[1.1] font-medium tracking-[-0.02em] text-balance sm:text-[48px]">
        {post.title}
      </h1>
      {post.dek && (
        <p className="mt-4 text-[19px] leading-[1.5] text-ink-2">{post.dek}</p>
      )}
      <div className="tnum mt-5 text-[13px] text-ink-3">
        {post.author}, {formatDate(post.date)}, {post.minutes} min read
      </div>
      <div
        className="prose mt-10 border-t border-sep pt-10"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <aside className="mt-14 rounded-[18px] border border-sep bg-cell p-6">
        <h2 className="font-display text-[22px] font-medium">Try it</h2>
        <p className="mt-1 text-ink-2">
          Watch any Arkiv entity and get a Telegram message before it expires.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <LinkButton href={`https://t.me/${bot}`} variant="primary">
            Open in Telegram
          </LinkButton>
          <LinkButton href="#/docs/introduction">Read the docs</LinkButton>
        </div>
      </aside>
    </article>
  );
}
