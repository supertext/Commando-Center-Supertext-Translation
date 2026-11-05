# Supertext Commando Center

Which Supertext plugin version does each customer site run, on which CMS, shop or PIM version and which PHP or Node.js version? The Commando Center collects version reports from the [Supertext translation plugins](https://github.com/Supertext) and shows them to Supertext staff:

- every installation, identified by its site URL, with the plugin, system and runtime versions it last reported
- which installations have a plugin update available (compared with the latest GitHub release)
- whether each site's Supertext API key works: the plugins check it automatically and report the result
- whether each site is reachable from the internet (for future callbacks): the center pings the plugin's endpoint
- the history of each installation: when the plugin, the system or the runtime was updated
- manual mapping of installations to Supertext clients, with notes
- which plugins send their translations through the Supertext translation proxy, with their usage

Plugins report when their settings are saved and after an update. Reporting is on by default and can be turned off in each plugin's settings. The key check runs in the plugin; only its result is sent. No content, API keys or personal data are sent.

Staff sign in with their Supertext account (Supertext's Person Service, OpenID Connect). Next.js and PostgreSQL, deployed on Railway.

The plugin side lives here too: [Supertext Plugin Health](plugin-health/README.md) (TypeScript, PHP, Python, .NET, Java) is the library every plugin bundles to send the reports and answer the ping.

## Documentation

- [Installation guide](docs/INSTALLATION.md): deploy on Railway, settings, update, troubleshooting
- [User guide](docs/USER_GUIDE.md): installations, history, mapping to clients
- [Developer guide](docs/DEVELOPER.md): the report protocol every plugin implements, architecture, tests, releasing

The protocol's JSON schema and test vectors are in [`spec/`](spec/).

## License

MIT, see [LICENSE](LICENSE).
