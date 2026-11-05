# User guide

Plugin Health shows which Supertext plugin version each customer site runs, on which system and runtime version, whether its API key works, whether it can be reached from the internet, and what changed when. This guide is for Supertext staff who look things up and map sites to clients. Setup is in the [installation guide](INSTALLATION.md).

## Sign in

Open the dashboard and click **Sign in with Supertext**. You sign in with your Supertext account, as in Supertext's other admin tools (if you are already signed in there, you come straight back). You need the *Administrator* role in Supertext; without it, the dashboard says *Your Supertext account isn't allowed to use Plugin Health*: ask an administrator for access.

You stay signed in for 12 hours on that browser. Your name and *Sign out* are at the top right; *Sign out* also signs you out of the Supertext login.

![Login page of Plugin Health with the Sign in with Supertext button](images/login.png)

While the dashboard is being switched over, or when the Supertext login is down, the login page may also show a field for the shared password below the button. Use it only if you were given that password.

## Installations

The start page lists every installation that has reported: one row per site URL and plugin.

![Installations list: counts at the top, filters, and a table with site, client, plugin, plugin version with status, API key check, reachability, system with runtime and last report](images/installations.png)

| Column | Meaning |
| --- | --- |
| **Site** | The site's URL as the plugin reported it. It identifies the installation; click it for details |
| **Client** | The Supertext customer it is mapped to (by hand, see below) |
| **Plugin** | Which Supertext plugin; links to its GitHub repository |
| **Plugin version** | The installed version, linked to its release notes, with a status: **latest**, **X.Y.Z available** (an update exists), **newer than release** (a development build) or **no release** (no published release found) |
| **API key** | The result of the plugin's latest automatic key check (hover for the time and details), see below |
| **Reachable** | Whether the dashboard reached the plugin from the internet with its last ping, see below |
| **System** / **Runtime** | The CMS, shop or PIM with its version, and the PHP, Node.js, … version |
| **Last report** | When the plugin last reported and why: *installed*, *settings saved*, *upgraded* (the plugin, the system or the runtime changed), *key checked* (the key check result changed, e.g. a translation was rejected) or *check* |

The counts at the top show how many installations there are, how many have a plugin update available, how many have an API key problem, how many aren't reachable from the internet, how many aren't mapped to a client yet, and how many reported in the last 30 days.

### API key check

Each plugin checks its Supertext API key automatically when its settings are saved, when the key changes in its configuration, and when Supertext rejects a translation. The check costs nothing (it translates nothing). The dashboard shows the latest result:

| Badge | Meaning | What to do |
| --- | --- | --- |
| **key ok** | Supertext accepted the key | – |
| **key rejected** | Supertext refused the key (HTTP 401/403): mistyped, deleted or revoked | Ask the customer to enter a valid key, or check the account in Supertext |
| **no key** | The plugin is installed but has no key yet | Help the customer finish the setup |
| **Supertext unreachable** | The site couldn't reach Supertext when it checked (firewall, proxy, outage) | If it stays like this, the customer's server probably can't reach the Supertext API |
| **check failed** | Supertext answered with another error (status in brackets) | Look at the details on the installation page |
| **not checked** | This plugin version doesn't send a key check yet | Recommend the plugin update |

### Reachable from the internet

So that Supertext can call installations back later (for example "your translation is ready"), the dashboard pings each plugin from the internet: it calls the plugin's small public ping endpoint and checks that the plugin itself answers. It pings after a report (at most once a minute per site) and when you press **Ping now**.

| Badge | Meaning | Typical cause |
| --- | --- | --- |
| **reachable · 12 ms** | The plugin answered; the time is how long it took | – |
| **not reachable** | No connection | Firewall, intranet-only site, DNS name not public, expired TLS certificate |
| **blocked** | The site answered with an error or a redirect | The whole site is behind a login (typical for staging), a firewall rule returns 403 |
| **wrong answer** | Something answered, but not the plugin | A cache, maintenance or firewall page in front of the site |
| **refused** | The dashboard didn't ping | The endpoint isn't on the site's own host, or points to a private address |
| **no endpoint** | This plugin version has no ping endpoint, or reporting is off | Recommend the plugin update |

Hover a badge for the details and time. A site that isn't reachable still works normally: only future callbacks from Supertext need it.

### Filters

Search by URL, client, system or notes; filter by plugin, client (or *Not mapped*), plugin version status, API key check and reachability. *Update available* answers "who still runs an old version?":

![Installations filtered to Update available: only the sites with an outdated plugin version](images/installations-outdated.png)

*Key problem* lists every site whose last key check wasn't ok:

![Installations filtered to Key problem: a rejected key, a site without key and a site that couldn't reach Supertext](images/installations-key-problems.png)

*Not reachable* lists every site whose last ping didn't reach the plugin:

![Installations filtered to Not reachable: a site that couldn't be reached, a wrong answer from a maintenance page and a staging site behind a login](images/installations-not-reachable.png)

Local and test sites (`localhost`, `*.test`, `*.ddev.site`, private IP addresses, …) are hidden; tick *Show local and test hosts* to see them, for example a developer's installation.

## One installation

The installation page shows the latest report, the client mapping and the history of all reports.

![Installation page: latest report with the API key check on the left, client and notes on the right, reachability below, then the history with the key check and the change in each report](images/installation.png)

Under **Reachable from the internet** you see the plugin's ping endpoint, the last result and the last pings. **Ping now** pings again right away, for example after the customer opened their firewall:

![Reachable from the internet: the ping endpoint, the last result with its time, the Ping now button and the last pings with trigger and result](images/installation-reachability.png)

The **History** lists every report, newest first, with its key check result and what changed compared with the report before: *Plugin 2.0.0 → 2.1.0*, *WordPress 6.8.3 → 6.9.0*, *API key rejected → ok*. Reports sent after an update carry no key check; the installation keeps the result of the last check. A plugin reports when its settings are saved and after the plugin, the system or the runtime was updated (with the next back-end request after the update).

## Map installations to clients

Plugins only send their URL, so the dashboard doesn't know whose site it is. On the installation page, under **Client and notes**:

- pick an existing client, or
- type a name under *Or a new client* to create one,

add notes if useful (production or staging, contact person) and click **Save**. Map staging and production sites to the same client.

## Clients

*Clients* lists all clients with the number of installations. Add a client with *Add client*, or create it while mapping an installation.

![Clients list with the number of installations per client](images/clients.png)

The client page lists the client's installations with their versions, and lets you rename the client and keep notes.

![Client page: the client's installations with plugin, system and runtime versions, then name and notes](images/client.png)

## Translation proxy

*Translation proxy* shows which plugins send their translations through the Supertext translation proxy: per customer (one Supertext API key, labelled in the proxy) the plugin, its version (with the same *latest* / *update available* status as the installations), the SDK, how many documents it uploaded, how many of them the proxy answered from its translation memory without calling Supertext, its key checks and its first and last request. The numbers are at most a minute old. Translations, corrections and review links are managed in the proxy itself, not here.

![Translation proxy tab: three plugins with their customers, uploads and how many were answered from the memory](images/proxy.png)

If the tab says it isn't connected, `COMMANDO_PROXY_URL` and `COMMANDO_PROXY_TOKEN` are missing (see the installation guide).

## Delete

- **Delete installation** (installation page) removes it and its history, for example a test site or a site with an outdated URL. If the plugin reports again, it comes back as a new installation.
- **Delete client** (client page) removes the client; its installations stay and become unmapped.

## What the plugins send

The site URL, the plugin, system and runtime versions, the SDK version, whether an API key is set, the result of the key check and the address of the plugin's ping endpoint. No content, no API keys and no personal data. Administrators can turn reporting off in each plugin's settings (*Send version information to Supertext*); a site that turned it off stops reporting, and its last report stays in the dashboard.

Anyone who knows the address could send a report, so treat the data as information for support, not as proof.
