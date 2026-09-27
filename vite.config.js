import { defineConfig } from 'vite';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Content-Security-Policy. Two profiles: a permissive one for `vite dev` (HMR
// needs inline/eval + a WebSocket), and a strict one baked into the production
// build. The strict policy is the real hardening — it blocks injected inline
// scripts (XSS), stops CSS `url()` / <img> beacons and any exfil to third
// parties, and forbids plugins, framing, and <base> hijacking.
//
// `style-src` keeps 'unsafe-inline' because the app legitimately sets inline
// styles (banner gradients/positions, the SVG graph); rendered markdown is
// stripped of style by DOMPurify, so the residual risk is CSS-only.
//
// `script-src` never needs 'unsafe-inline': the one inline script (the pre-paint
// theme boot in index.html) is allow-listed by its SHA-256 hash in production.
// Dev keeps 'unsafe-inline' and no hashes, because a hash in the policy would
// switch 'unsafe-inline' off for the HMR client.
const CSP = {
  dev: [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; '),
  prod: (scriptHashes = []) =>
    [
      "default-src 'self'",
      ["script-src 'self'", ...scriptHashes].join(' '),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      // NB: `frame-ancestors` is intentionally omitted — it's ignored when a CSP
      // is delivered via <meta>. Set it (or X-Frame-Options) as an HTTP response
      // header at the hosting layer for clickjacking protection.
    ].join('; '),
};

/** CSP source expressions for every bare inline `<script>` in the final HTML. */
function inlineScriptHashes(html) {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`,
  );
}

// Stamp a per-build id into the copied dist/sw.js CACHE name. Because the built
// asset filenames are content-hashed, hashing them yields an id that changes only
// when the app actually changes — so every real deploy makes the SW bytes differ,
// the browser installs the new worker, and its activate step deletes the old cache.
function swVersionPlugin() {
  return {
    name: 'sw-build-version',
    apply: 'build',
    closeBundle() {
      const dist = resolve('dist');
      const swPath = resolve(dist, 'sw.js');
      let sw;
      try {
        sw = readFileSync(swPath, 'utf8');
      } catch {
        return;
      } // no SW emitted
      let assets = [];
      try {
        assets = readdirSync(resolve(dist, 'assets')).sort();
      } catch {
        /* none */
      }
      const hash = createHash('sha256').update(assets.join('|')).digest('hex').slice(0, 12);
      writeFileSync(
        swPath,
        sw.replace(/__BUILD_HASH__/g, hash).replace('/* __PRECACHE_ASSETS__ */ []', JSON.stringify(assets)),
      );
    },
  };
}

// Runs `post` and after minifyHtmlPlugin so the hash covers the inline script
// exactly as it is emitted (the minifier may touch surrounding whitespace). The
// meta is spliced in as a string rather than via `tags`, which would HTML-escape
// every quote in the policy to `&#39;` (correct, but ~70 wasted shell bytes).
function cspPlugin() {
  return {
    name: 'inject-csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const content = ctx.server ? CSP.dev : CSP.prod(inlineScriptHashes(html));
        return html.replace(
          /<head[^>]*>/i,
          (head) => `${head}<meta http-equiv=Content-Security-Policy content="${content}">`,
        );
      },
    },
  };
}

// Stamp the source commit into the shell so drift between the github.io mirror
// and the canonical systembydave.com/noteforge/ copy is inspectable with one
// curl:
//   curl -s https://systembydave.com/noteforge/ | grep -o 'noteforge-build content=[0-9a-f]*'
// system-by-dave's scripts/verify_noteforge_release.js requires the value to
// be a prefix of the provenance sourceCommit, and its nightly drift check
// compares the live page against provenance. Twelve hex characters (the same
// width as the service-worker cache id) keep the tag inside the initial-shell
// ceiling in docs/implementation/performance_budgets.md, which had 71 bytes of
// headroom at 392ed92; the full 40-character SHA would cost 76.
const BUILD_STAMP_LENGTH = 12;

function resolveBuildCommit() {
  if (process.env.NOTEFORGE_BUILD_SHA) return process.env.NOTEFORGE_BUILD_SHA.trim();
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function buildStampPlugin() {
  return {
    name: 'noteforge-build-stamp',
    apply: 'build',
    transformIndexHtml(html) {
      const commit = resolveBuildCommit();
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        throw new Error(
          'noteforge-build-stamp: cannot resolve the source commit; build inside the git checkout or set NOTEFORGE_BUILD_SHA to the 40-character SHA',
        );
      }
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { name: 'noteforge-build', content: commit.slice(0, BUILD_STAMP_LENGTH) },
            injectTo: 'head',
          },
        ],
      };
    },
  };
}

function minifyHtmlPlugin() {
  return {
    name: 'minify-html',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html
          .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
          .replace(/>\s+</g, '><')
          .replace(/\n\s+/g, ' ')
          .replace(/\s+\/>/g, '>')
          .replace(/\s([a-zA-Z_:][\w:.-]*)="([a-zA-Z0-9._:/#-]+)"/g, ' $1=$2')
          .trim();
      },
    },
  };
}

export default defineConfig(({ command, isPreview }) => ({
  root: '.',
  // Production is served from the /noteforge/ sub-path (systembydave.com/noteforge/,
  // and a davehomeassist.github.io/noteforge/ mirror); dev + the test servers stay at
  // root so nothing else has to change.
  base: command === 'build' || isPreview ? '/noteforge/' : '/',
  // Order matters: the CSP plugin runs `post`, after the build stamp and the
  // minifier, so its hash covers the inline theme script exactly as emitted.
  plugins: [buildStampPlugin(), minifyHtmlPlugin(), cspPlugin(), swVersionPlugin()],
  server: {
    port: 5175,
    open: true,
  },
  // All three runtime dependencies are known up front. Pre-bundling the lazy
  // YAML adapter prevents a first Properties test/use from triggering Vite's
  // dependency-discovery restart in the middle of an authoritative request.
  optimizeDeps: {
    include: ['dompurify', 'marked', 'yaml'],
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    // No inline modulepreload polyfill, so the production CSP stays at
    // `script-src 'self'` plus one hash (no 'unsafe-inline'). es2020 targets support it.
    modulePreload: { polyfill: false },
  },
}));
