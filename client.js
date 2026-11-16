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
    const useRef = React.useRef;
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
    var renderSeq = 0;

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

    /** Map the DSH palette onto mermaid's `themeVariables`. */
    function themeVariables() {
      return {
        background: 'transparent',
        primaryColor: cssVar('--dsw-alias-bg-layer-2', '#f8fafc'),
        primaryTextColor: cssVar('--dsw-alias-label-primary', '#0f172a'),
        primaryBorderColor: cssVar('--dsw-alias-border-l2', '#cbd5e1'),
        lineColor: cssVar('--dsw-alias-border-l2', '#cbd5e1'),
        secondaryColor: cssVar('--dsw-alias-bg-layer-3', '#f1f5f9'),
        tertiaryColor: cssVar('--dsw-alias-bg-layer-1', '#ffffff'),
        clusterBkg: cssVar('--dsw-alias-bg-layer-2', '#f8fafc'),
        clusterBorder: cssVar('--dsw-alias-border-l2', '#cbd5e1'),
        edgeLabelBackground: cssVar('--dsw-alias-bg-layer-1', '#ffffff'),
        nodeBorder: cssVar('--dsw-alias-border-l2', '#cbd5e1'),
        fontFamily: cssVar('--dsh-font-family-text', cssVar('--dsw-font-family', 'system-ui, sans-serif')),
        fontSize: '13px',
        textColor: cssVar('--dsw-alias-label-primary', '#0f172a'),
      };
    }

    /** Signature of the tokens we consume; changes when the palette swaps. */
    function themeSignature() {
      try {
        return JSON.stringify(themeVariables());
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
      var renderIdRef = useRef(0);

      useEffect(function () {
        var renderId = ++renderIdRef.current;
        var cancelled = false;
        setLoading(true);
        setFailed(false);
        setSvg('');

        loadMermaid().then(function (mermaid) {
          if (cancelled || renderId !== renderIdRef.current) return;
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
                if (cancelled || renderId !== renderIdRef.current) return;
                var outSvg = out && out.svg ? out.svg : '';
                if (outSvg) setSvg(outSvg);
                else setFailed(true);
              });
          } catch (error) {
            if (!cancelled && renderId === renderIdRef.current) setFailed(true);
          }
        }).catch(function () {
          if (!cancelled && renderId === renderIdRef.current) setFailed(true);
        }).then(function () {
          if (!cancelled && renderId === renderIdRef.current) setLoading(false);
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
      '.dsh-mermaid-loading{height:64px;border-radius:var(--dsw-radius-md,8px);',
      'background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));',
      'animation:dsh-mermaid-pulse 1.2s ease-in-out infinite}',
      '@keyframes dsh-mermaid-pulse{0%,100%{opacity:.6}50%{opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.dsh-mermaid-loading{animation:none}}',
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
        });
      },
    };
  },
});
