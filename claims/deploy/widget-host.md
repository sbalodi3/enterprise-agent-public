# Hosting claims widgets and the wage-evidence pilot

Workbench and managed Claims Chat display the same three bundled MCP Apps through an intermediate web origin. Run the sandbox listener in the Workbench process. It serves the proxy document and accepts no application API traffic. The timeline, case list and portfolio summary need no additional runtime, package installation or container per widget.

| Environment | Employee Workbench | Widget origin | Route |
|---|---|---|---|
| Local baseline | `http://localhost:3080` | `http://claims-widgets.localhost:4380` | Loopback port mapping to Workbench port 3098 |
| Local showcase | `http://127.0.0.1:3180` | `http://claims-widgets.localhost:4381` | Kong host route to Workbench port 3098 |
| Production example | `https://workbench.example.com` | `https://claims-widgets.example.net` | Dedicated TLS virtual host to the same sandbox listener |

The host supplies its resolved light or dark theme and accepts content-height updates up to 440 px. Longer results scroll within the app. The resource loader bundles the shared styles, formatting and message handling into each HTML response. Search, filters and pagination run in the employee host. Case rows open Workbench, and cited timeline entries open the authorized passage in the host reader.

## Production ingress

Set `CLAIMS_APP_ORIGIN` and `CLAIMS_WIDGET_ORIGIN` to their browser-visible origins, without a trailing slash. Set `CLAIMS_WIDGET_PARENT_ORIGINS` to the comma-separated list of exact managed Chat browser origins. Workbench is allowed automatically. Set `CLAIMS_WIDGET_BIND` to the interface reachable by ingress and `CLAIMS_WIDGET_LISTEN_PORT` to the internal listener port (default 3098). Local HTTP is supported on loopback hostnames. HTTPS is required elsewhere.

Provision DNS and TLS for the widget hostname. Route that hostname exclusively to the sandbox listener, preserve the original Host header (including any nondefault port), and allow only GET /proxy with its parent query string. Keep the public employee and identity routes on their application hostnames. Use host-only employee session cookies or an independent registrable domain for the widgets. At ingress strip Cookie and Authorization before forwarding to the sandbox. Permit this origin in the employee page’s frame-src policy, and pass through the proxy response’s CSP and Permissions-Policy. Explicitly test every production browser parent, including managed Chat.

After rollout request `/proxy?parent=<URL-encoded employee origin>` on the widget virtual host. Expect 200, no Set-Cookie, and frame-ancestors containing exactly that parent. An unknown parent and `/claims/api/status` on the widget host must return 404. Sign in, open each widget, and follow one authorized source or case link. If widgets cannot mount, the application opens the text view. To roll back to text only, set `CLAIMS_WIDGETS_DISABLED=1` and restart Workbench.

## A2UI pilot

Set `CLAIMS_WAGE_REVIEW=1` only in the intended pilot environment. The standard image builds the pinned Lit renderer into a local JavaScript asset. For a development checkout use `npm --prefix claims ci --workspaces=false` and `npm --prefix claims run build:review`. The browser loads the bundle on demand. The pilot uses the existing claims database, authorized MCP reads and configured local model. A completed turn with an invalid ordering uses the fixed catalog order. A failed model turn offers retry and access to the claim record. To disable new pilot reviews, set the flag to 0 and restart Workbench. Saved answers retain their authorized text and citations.

On the connected showcase, open WC-102, select **Review missing wage evidence**, follow a cited passage and use **Open in Chat** to reopen the saved conversation. Use the [study protocol](../showcase/wage-study/README.md) to stage the eight cases in a dedicated study copy and record adjuster results. Promotion to additional workflows depends on the study gates.
