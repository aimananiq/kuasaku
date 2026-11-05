import { cache } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { PublicFormNotice, PublicFormShell } from '@/components/reach/public-form-shell';
import { PublicChat } from '@/components/crm/public-chat';
import { PublicLeadForm } from '@/components/reach/public-lead-form';
import { hasSupabaseEnv } from '@/lib/auth/viewer';
import { DEFAULT_BUTTON_LABEL } from '@/lib/crm/landing-pages';
import { getPublicChatbot } from '@/lib/crm/public-chatbot';
import {
  countLandingPageView,
  getPublicLandingPage,
  landingPageConsentText,
} from '@/lib/crm/public-landing-pages';
import { createAnonymousClient } from '@/lib/reach/public-forms';
import { createClient } from '@/lib/supabase/server';
import { submitLandingPageAction } from './actions';

/**
 * A Kasturi landing page's public address: /p/<page id>. Anyone can open it,
 * signed in or not; it sits outside the signed-in app and shows none of it.
 */

type Props = { params: Promise<{ pageId: string }> };

/** Search engines are asked not to list people's pages, whatever state they are in. */
const ROBOTS = { index: false, follow: false } as const;

/**
 * One lookup per request, shared by the page and its title. A link that is not
 * a page id, or a site with no database, has no page behind it.
 */
const loadPage = cache(async (rawId: string) => {
  const id = z.uuid().safeParse(rawId);
  if (!id.success || !hasSupabaseEnv()) return null;
  const page = await getPublicLandingPage(createAnonymousClient(), id.data);
  return page ? { id: id.data, page } : null;
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const found = await loadPage((await params).pageId);
  // A page that is not available gives nothing away, in the title either.
  const title = found?.page.available ? `${found.page.headline} · ${found.page.orgName}` : 'Page';
  return {
    title,
    description: (found?.page.available && found.page.subheadline) || null,
    robots: ROBOTS,
    // Replaces the site-wide share text, which is about KuasabyRickworks, not this page.
    openGraph: { title },
    twitter: { card: 'summary', title },
  };
}

export default async function PublicLandingPage({ params }: Props) {
  const found = await loadPage((await params).pageId);
  if (!found) notFound();
  const { id, page } = found;

  // The sentence a visitor ticks to agree, from the page's form. Without it the
  // form cannot be agreed to, so the page is shown as not available.
  const consentText = page.available ? await landingPageConsentText(id) : null;

  if (!page.available || !consentText) {
    return (
      <PublicFormShell>
        <PublicFormNotice title="Page not available">
          This page is not open at the moment. Please check back later.
        </PublicFormNotice>
      </PublicFormShell>
    );
  }

  // The visitor's own session says who they are, so a member of this workspace
  // who is only previewing their page is left out. One view per client per window.
  await countLandingPageView(await createClient(), id);

  // The workspace's chatbot, when the page carries it and the bot can answer.
  const chatbot = await getPublicChatbot(id);

  // Blank lines in the text separate paragraphs; single line breaks are kept.
  const rawParagraphs = (page.body ?? '')
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  // The first picture is the hero; any other picture stays where the writer put it.
  const imageRegex = /^!\[(.*?)\]\((https:\/\/[^\s)]+)\)$/;
  let heroImage: { alt: string; url: string } | null = null;
  const contentParagraphs: string[] = [];

  for (const para of rawParagraphs) {
    const match = para.match(imageRegex);
    if (match && !heroImage) {
      heroImage = { alt: match[1] || 'Hero Visual', url: match[2] };
    } else {
      contentParagraphs.push(para);
    }
  }

  return (
    <div className="flex min-h-dvh w-full flex-col bg-gradient-to-b from-primary/5 via-background to-muted/40">
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:py-12">
        {heroImage ? (
          <section className="relative isolate overflow-hidden rounded-3xl border shadow-lg">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroImage.url} alt={heroImage.alt} className="h-[340px] w-full object-cover sm:h-[420px]" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/40 to-black/5" />
            <div className="absolute inset-x-0 bottom-0 space-y-3 p-6 text-white sm:p-10">
              <p className="text-sm font-medium uppercase tracking-wider text-white/80">{page.orgName}</p>
              <h1 className="text-3xl font-bold tracking-tight break-words sm:text-5xl">{page.headline}</h1>
              {page.subheadline ? <p className="max-w-2xl text-base text-white/90 break-words sm:text-lg">{page.subheadline}</p> : null}
              <a
                href="#register"
                className="inline-flex h-11 items-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-md transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                {page.buttonLabel || DEFAULT_BUTTON_LABEL}
              </a>
            </div>
          </section>
        ) : (
          <header className="space-y-4 rounded-3xl border bg-gradient-to-br from-primary/10 to-transparent p-6 sm:p-10">
            <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">{page.orgName}</p>
            <h1 className="text-3xl font-bold tracking-tight break-words sm:text-5xl">{page.headline}</h1>
            {page.subheadline ? <p className="max-w-2xl text-lg text-muted-foreground break-words">{page.subheadline}</p> : null}
            <a
              href="#register"
              className="inline-flex h-11 items-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground shadow-md transition hover:opacity-90"
            >
              {page.buttonLabel || DEFAULT_BUTTON_LABEL}
            </a>
          </header>
        )}

        {contentParagraphs.length > 0 ? (
          <div className="space-y-5 text-base leading-relaxed break-words">
            {contentParagraphs.map((paragraph, index) => (
              <PageBlock key={index} text={paragraph} />
            ))}
          </div>
        ) : null}
        <section id="register" className="scroll-mt-6 rounded-2xl border bg-card p-6 text-card-foreground shadow-md sm:p-8">
          <PublicLeadForm
            action={submitLandingPageAction.bind(null, id)}
            consentText={consentText}
            submitLabel={page.buttonLabel || DEFAULT_BUTTON_LABEL}
          />
        </section>
      </main>
      <footer className="px-4 pb-6 text-center text-xs text-muted-foreground">
        <Link
          href="/"
          // A plain link: nothing is fetched ahead of a click.
          prefetch={false}
          className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Powered by KuasabyRickworks
        </Link>
      </footer>
      {chatbot ? (
        <PublicChat
          pageId={id}
          botName={chatbot.botName}
          welcome={chatbot.welcome}
          handoffEnabled={chatbot.handoffEnabled}
        />
      ) : null}
    </div>
  );
}


/** **bold** inside a line of text; nothing else is interpreted, so a page cannot inject markup. */
function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={i} className="font-semibold text-foreground">
            {part.slice(2, -2)}
          </strong>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const IMAGE_LINE = /^!\[(.*?)\]\((https:\/\/[^\s)]+)\)$/;

function PageBlock({ text }: { text: string }) {
  if (text.startsWith('## ')) {
    return (
      <h2 className="flex items-center gap-3 pt-4 text-2xl font-bold tracking-tight text-foreground">
        <span className="h-7 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
        <Inline text={text.slice(3)} />
      </h2>
    );
  }
  if (text.startsWith('### ')) {
    return (
      <h3 className="text-lg font-semibold text-foreground">
        <Inline text={text.slice(4)} />
      </h3>
    );
  }
  const image = text.match(IMAGE_LINE);
  if (image) {
    return (
      <figure className="overflow-hidden rounded-2xl border shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image[2]} alt={image[1]} className="h-auto w-full object-cover" loading="lazy" />
      </figure>
    );
  }
  if (text.startsWith('> ')) {
    return (
      <blockquote className="rounded-xl border-l-4 border-primary bg-card/70 p-5 italic text-muted-foreground shadow-xs">
        <Inline text={text.replace(/^>\s*/gm, '')} />
      </blockquote>
    );
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length > 0 && lines.every((l) => /^[*•-]\s+/.test(l))) {
    // Benefits read as cards, not as a plain list.
    return (
      <ul className="grid gap-3 sm:grid-cols-2">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-3 rounded-xl border bg-card p-4 shadow-xs">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground" aria-hidden>
              ✓
            </span>
            <span className="text-foreground/90">
              <Inline text={l.replace(/^[*•-]\s+/, '')} />
            </span>
          </li>
        ))}
      </ul>
    );
  }
  if (lines.length > 0 && lines.every((l) => /^\d+[.)]\s+/.test(l))) {
    return (
      <ol className="space-y-3">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-bold text-primary" aria-hidden>
              {i + 1}
            </span>
            <span className="pt-0.5 text-muted-foreground">
              <Inline text={l.replace(/^\d+[.)]\s+/, '')} />
            </span>
          </li>
        ))}
      </ol>
    );
  }
  return (
    <p className="whitespace-pre-line text-muted-foreground">
      <Inline text={text} />
    </p>
  );
}
