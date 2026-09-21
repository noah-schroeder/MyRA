# Security

MyRA runs locally by default, but some tools call external services you
configure it to use — a hosted model provider, a research API, Hugging Face.
See the README's "What leaves this machine" for exactly what it sends and
when.

For what contains the agent — what it can reach, what it cannot, and what
MyRA does not defend against — see
[docs/threat-model.md](docs/threat-model.md).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting rather than a public
issue: open the **Security** tab on this repository and click **Report a
vulnerability**. That reaches the maintainer directly and keeps the report
private until there's a fix.

If that tab isn't available for some reason, open a regular issue asking to
be pointed at another way to report privately — please don't post exploit
details in it.
