/**
 * dsh-mermaid — Client half.
 *
 * Registers a `mermaid` layer on Chat's language-keyed fence slot
 * (`conversation.chat.markdown.fence`). Every ```` ```mermaid ```` fence in agent
 * output is handed to this layer with its `code`, `streaming` flag and the inner
 * code block as `children`; the layer replaces the block with a live SVG once
 * the document settles.
 *
 * Design notes:
 *  - While the turn streams, the raw source stays on screen, so a half-finished
 *    diagram never flashes a parse error (the same contract Chat's own `math`
 *    layer follows).
 *  - The mermaid bundle is fetched from this plugin's own Host route, so the
 *    renderer is self-contained: no CDN, no file outside the bundle.
 *  - Colours come from the DSH theme tokens the ThemePresenter writes on `body`
 *    (`--dsw-alias-*`), so the diagram follows light/dark and any registered
 *    palette instead of mermaid's hard-coded defaults. A missing token degrades
 *    that one slot to a fallback colour rather than breaking the render.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-mermaid',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useCallback = React.useCallback;

    /**
     * Resolve one Host route against the page's own directory.
     *
     * A leading slash would pin the request to the origin root and escape a
     * reverse-proxy prefix; relative resolution works in both the browser and
     * the Electron window (the desktop shell forwards same-origin page paths).
     */
    function routeUrl(path) {
      var base = typeof document !== 'undefined' ? document.baseURI : '';
      try {
        var url = new URL(base || 'http://dsh.internal/');
        url.search = '';
        url.hash = '';
        if (!url.pathname.endsWith('/')) url.pathname += '/';
        return new URL(path.replace(/^\/+/, ''), url.href).href;
      } catch {
        return null;
      }
    }

    var MERMAID_SRC = routeUrl('dsh-mermaid/mermaid.min.js');
    var mermaidPromise = null;
    // Module-wide monotonic render id. Per-instance counters restart at 1 for
    // every diagram, so two diagrams in one conversation both got the id
    // "dsh-mermaid-1". mermaid removes/rebuilds its temporary DOM nodes by that
    // id, so the second render clobbered the first and the two SVGs overlapped
    // and cross-wired each other's <defs>. One shared counter keeps every id
    // unique for the lifetime of the page.
    var renderSeq = 0;
    // mermaid keeps its diagram DB in a module-level singleton, so concurrent
    // render() calls can interleave on that shared state. Serialize all renders
    // through one global promise chain; a rejected render must not poison it.
    var renderChain = Promise.resolve();
    function enqueueRender(run) {
      var result = renderChain.then(run, run);
      renderChain = result.then(function () {}, function () {});
      return result;
    }

    /**
     * Load the bundle exactly once and hand back the global `mermaid` object.
     * The UMD build ends with `globalThis["mermaid"] = …default`, so a plain
     * `<script>` tag is enough; no module system or CDN involved.
     */
    function loadMermaid() {
      if (mermaidPromise) return mermaidPromise;
      mermaidPromise = new Promise(function (resolve, reject) {
        if (typeof window !== 'undefined' && window.mermaid) {
          return resolve(window.mermaid);
        }
        if (!MERMAID_SRC) {
          return reject(new Error('dsh-mermaid: mermaid bundle route is unavailable'));
        }
        var script = document.createElement('script');
        script.src = MERMAID_SRC;
        script.async = true;
        script.onload = function () {
          if (window.mermaid) resolve(window.mermaid);
          else reject(new Error('dsh-mermaid: bundle loaded but window.mermaid is missing'));
        };
        script.onerror = function () {
          reject(new Error('dsh-mermaid: failed to load the mermaid bundle'));
        };
        document.head.appendChild(script);
      });
      return mermaidPromise;
    }

    /**
     * Read a DSH token from the element that carries the active theme.
     *
     * The base tokens live on `:root`, but ThemePresenter overrides the active
     * palette as inline variables on `body`; custom properties inherit downward,
     * so `body` is the element whose computed value is the one actually in use.
     */
    function cssVar(name, fallback) {
      try {
        var el = (typeof document !== 'undefined' && document.body) || document.documentElement;
        var value = getComputedStyle(el).getPropertyValue(name);
        value = (value || '').trim();
        return value || fallback;
      } catch {
        return fallback;
      }
    }

    /**
     * Decide whether the active palette is dark.
     *
     * The ThemePresenter marks dark with a `data-ds-dark-theme` attribute on
     * `body`, so that is the authoritative signal; the media query and the
     * theme-source attribute cover palettes that follow the system or a
     * non-standard source.
     */
    function isDarkMode() {
      try {
        var body = typeof document !== 'undefined' ? document.body : null;
        if (body && body.hasAttribute && body.hasAttribute('data-ds-dark-theme')) return true;
        var de = typeof document !== 'undefined' ? document.documentElement : null;
        if (de && de.getAttribute) {
          var src = (de.getAttribute('data-ds-theme-source') || '').toLowerCase();
          if (src.indexOf('dark') !== -1) return true;
        }
        var mql = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null;
        return !!(mql && mql.matches);
      } catch {
        return false;
      }
    }

    /** Map the DSH palette onto mermaid's `themeVariables`. */
    function themeVariables() {
      // Edges and node borders need real contrast against the background. The
      // theme's `border-l2` is a hairline token (rgba(...,.12) in dark), which is
      // far too faint to serve as a diagram line, so pick a mid-tone label token
      // that inverts with the mode: a light line on dark, a dark line on light.
      var line = isDarkMode()
        ? cssVar('--dsw-alias-label-secondary', '#e2e8f0')
        : cssVar('--dsw-alias-label-tertiary', '#475569');
      var lineStrong = isDarkMode()
        ? cssVar('--dsw-alias-label-primary', '#f1f5f0')
        : cssVar('--dsw-alias-label-secondary', '#334155');
      return {
        background: 'transparent',
        primaryColor: cssVar('--dsw-alias-bg-layer-2', '#f8fafc'),
        primaryTextColor: cssVar('--dsw-alias-label-primary', '#0f172a'),
        primaryBorderColor: line,
        lineColor: line,
        secondaryColor: cssVar('--dsw-alias-bg-layer-3', '#f1f5f9'),
        tertiaryColor: cssVar('--dsw-alias-bg-layer-1', '#ffffff'),
        clusterBkg: cssVar('--dsw-alias-bg-layer-2', '#f8fafc'),
        clusterBorder: line,
        edgeLabelBackground: cssVar('--dsw-alias-bg-layer-1', '#ffffff'),
        nodeBorder: lineStrong,
        fontFamily: cssVar('--dsh-font-family-text', cssVar('--dsw-font-family', 'system-ui, sans-serif')),
        fontSize: '13px',
        textColor: cssVar('--dsw-alias-label-primary', '#0f172a'),
      };
    }

    /** Signature of the tokens we consume; changes when the palette swaps. */
    function themeSignature() {
      try {
        return JSON.stringify([themeVariables(), isDarkMode()]);
      } catch {
        return '';
      }
    }

    /**
     * Recompute the signature when the palette changes: ThemePresenter rewrites
     * `body` attributes and inline variables on every light/dark switch, and the
     * OS scheme query covers a palette that follows the system.
     */
    function useThemeKey() {
      var sigState = useState('');
      var sig = sigState[0], setSig = sigState[1];
      var update = useCallback(function () {
        setSig(themeSignature());
      }, []);
      useEffect(function () {
        update();
        var mql = typeof window.matchMedia === 'function'
          ? window.matchMedia('(prefers-color-scheme: dark)')
          : null;
        var onScheme = function () {
          update();
        };
        if (mql) {
          if (mql.addEventListener) mql.addEventListener('change', onScheme);
          else if (mql.addListener) mql.addListener(onScheme);
        }
        var mo = new MutationObserver(function () {
          update();
        });
        var targets = [];
        if (typeof document !== 'undefined') {
          if (document.body) targets.push(document.body);
          if (document.documentElement) targets.push(document.documentElement);
        }
        targets.forEach(function (target) {
          mo.observe(target, {
            attributes: true,
            attributeFilter: ['style', 'class', 'data-ds-dark-theme', 'data-ds-theme-source'],
          });
        });
        return function () {
          if (mql) {
            if (mql.removeEventListener) mql.removeEventListener('change', onScheme);
            else if (mql.removeListener) mql.removeListener(onScheme);
          }
          mo.disconnect();
        };
      }, []);
      return sig;
    }

    /** Render one settled mermaid document to SVG. */
    function MermaidDiagram(props) {
      var code = props.code;
      var themeKey = useThemeKey();
      var svgState = useState('');
      var svg = svgState[0], setSvg = svgState[1];
      var failedState = useState(false);
      var failed = failedState[0], setFailed = failedState[1];
      var loadingState = useState(true);
      var loading = loadingState[0], setLoading = loadingState[1];
      useEffect(function () {
        var renderId = ++renderSeq;
        var cancelled = false;
        setLoading(true);
        setFailed(false);
        setSvg('');

        loadMermaid().then(function (mermaid) {
          if (cancelled) return;
          return enqueueRender(function () {
            if (cancelled) return;
            try {
              mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                theme: 'base',
                themeVariables: themeVariables(),
                flowchart: { curve: 'basis', useMaxWidth: true },
              });
              return mermaid
                .render('dsh-mermaid-' + renderId, code)
                .then(function (out) {
                  if (cancelled) return;
                  var outSvg = out && out.svg ? out.svg : '';
                  if (outSvg) setSvg(outSvg);
                  else setFailed(true);
                });
            } catch (error) {
              if (!cancelled) setFailed(true);
            }
          });
        }).catch(function () {
          if (!cancelled) setFailed(true);
        }).then(function () {
          if (!cancelled) setLoading(false);
        });

        return function () {
          cancelled = true;
        };
      }, [code, themeKey]);

      // A parse/render failure must not eat the user's source: fall back to the
      // ordinary code block so the fence still shows exactly what was written.
      if (failed) return props.children;
      if (!svg) return h('div', { className: 'dsh-mermaid-loading', 'aria-hidden': true });
      return h('div', { className: 'dsh-mermaid', dangerouslySetInnerHTML: { __html: svg } });
    }

    /**
     * Normalize a (possibly malformed) image path from an `image` fence.
     *
     * Agents frequently write Windows paths with raw spaces, a stray `/`
     * before the drive, a `file://` prefix, or a relative path. Native
     * Markdown image rendering rejects most of these, so this helper folds
     * them into an absolute path that the host's /api/file route accepts.
     * Returns null when the text does not look like a usable path.
     */
    function normalizeImagePath(raw) {
      var value = (raw || '').trim();
      if (!value) return null;
      // Strip a surrounding sentence or quotes if the agent wrapped the path.
      var quoted = value.match(/^["'`](.+)["'`]$/s);
      if (quoted) value = quoted[1].trim();
      // file:// URI -> plain path (accept file:///D:/... and file:///C:/...).
      var fileUri = value.match(/^file:\/\/(?:\/)?([A-Za-z]:[\/\\].*)$/is);
      if (fileUri) value = fileUri[1];
      else if (/^file:\/\//i.test(value)) return null;
      // Unwrap angle brackets sometimes used around paths with spaces.
      var angled = value.match(/^<(.+)>$/s);
      if (angled) value = angled[1].trim();
      // Decode %XX escapes, but guard against malformed sequences.
      try { value = decodeURIComponent(value); } catch { /* keep raw text */ }
      value = value.replace(/\\/g, '/');
      // A leading slash before a Windows drive (/D:/foo) is a common typo.
      value = value.replace(/^\/+([A-Za-z]:\/)/, '$1');
      var isAbsolute = /^[A-Za-z]:\//.test(value) || /^\//.test(value);
      if (!isAbsolute) {
        // Relative path: resolve against the page directory (best effort).
        if (typeof document === 'undefined' || !document.baseURI) return null;
        try { value = new URL(value, document.baseURI).pathname; } catch { return null; }
        try { value = decodeURIComponent(value); } catch { /* keep as-is */ }
      }
      // Reject control characters; the host route refuses them.
      if (/[\u0000-\u001f\u007f]/.test(value)) return null;
      return value;
    }

    /** MIME type hint from the file extension; the host ignores it for access. */
    function imageMime(path) {
      var ext = (path.split('.').pop() || '').toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      if (ext === 'gif') return 'image/gif';
      if (ext === 'webp') return 'image/webp';
      if (ext === 'svg') return 'image/svg+xml';
      return 'image/png';
    }

    /**
     * Render one image fence. Fetches the bytes through the same-origin
     * authenticated /api/file route and shows them via a blob URL, so raw
     * spaces in the path are encoded correctly and the browser's credential
     * flow is preserved.
     */
    function ImageFence(props) {
      var raw = props.code || '';
      var failedState = useState(false);
      var failed = failedState[0], setFailed = failedState[1];
      var loadedState = useState(false);
      var loaded = loadedState[0], setLoaded = loadedState[1];
      var path = normalizeImagePath(raw);
      var src = path ? routeUrl('api/file?path=' + encodeURIComponent(path)) : null;
      useEffect(function () { setFailed(false); setLoaded(false); }, [raw]);
      if (!src || failed) return h('div', { className: 'dsh-image-fence-error' },
        'IMAGE_FENCE_FAILED: ' + (path || raw || '(empty path)'));
      return h('div', { className: 'dsh-image-fence' },
        !loaded ? h('div', { className: 'dsh-mermaid-loading', 'aria-hidden': true }) : null,
        h('img', {
          src: src, alt: 'image', className: 'dsh-image-fence-img',
          style: loaded ? void 0 : { display: 'none' },
          onLoad: function () { setLoaded(true); },
          onError: function () { setFailed(true); }
        }));
    }
    function ImageFenceLayer(props) {
      if (props.streaming) return props.children;
      return h(ImageFence, { code: props.code, children: props.children });
    }

    /**
     * The fence layer: keep the source while streaming, then hand off to the
     * renderer once the document settles.
     */
    function MermaidFenceLayer(props) {
      if (props.streaming) return props.children;
      return h(MermaidDiagram, { code: props.code, children: props.children });
    }

    var STYLES = [
      '.dsh-mermaid{display:flex;justify-content:center;align-items:center;padding:12px;overflow:auto}',
      '.dsh-mermaid svg{max-width:100%;height:auto;display:block}',
      /* Edges: mermaid's line color token is thin and can wash out on a dark
         backdrop; give edges a firm stroke that stays crisp while scaling. */
      '.dsh-mermaid svg .edgePath,.dsh-mermaid svg .edge-path,.dsh-mermaid svg path[class*="edge"]{stroke-width:1.6px;vector-effect:non-scaling-stroke}',
      '.dsh-mermaid svg .cluster{stroke-width:1.2px}',
      /* Mermaid places each subgraph title exactly on the cluster's top border,
         so the label sits half on the line. Nudge it down inside the box; the
         CSS `translate` property adds to the element's existing `transform`
         attribute without touching its horizontal position. */
      '.dsh-mermaid svg .cluster-label{translate:0 9px}',
      '.dsh-mermaid-loading{height:64px;border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));',
      'animation:dsh-mermaid-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsh-mermaid-pulse{0%,100%{opacity:.6}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dsh-mermaid-loading{animation:none}}',
      '.dsh-image-fence{display:flex;justify-content:center;padding:8px}',
      '.dsh-image-fence-img{max-width:100%;height:auto;border-radius:var(--dsw-radius-md,6px)}',
      '.dsh-image-fence-error{padding:8px;color:var(--dsw-alias-fg-danger,#e06c75);font-family:var(--dsw-font-mono,monospace);font-size:12px;word-break:break-all}',
    ].join('');

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(function () {
          var style = document.createElement('style');
          style.id = 'dsh-mermaid-styles';
          style.textContent = STYLES;
          document.head.appendChild(style);
          return function () {
            style.remove();
          };
        });
        ctx.slots.inject('conversation.chat.markdown.fence', function () {
          ctx.slots.register({
            name: 'conversation.chat.markdown.fence',
            key: 'mermaid',
            id: '@local/dsh-mermaid/fence/mermaid',
          }, MermaidFenceLayer);
          ctx.slots.register({
            name: 'conversation.chat.markdown.fence',
            key: 'image',
            id: '@local/dsh-mermaid/fence/image',
          }, ImageFenceLayer);
        });
      },
    };
  },
});