# Install

```sh
git clone https://github.com/tanvincible/mocon
npm install ./mocon/packages/typescript @opentelemetry/api
```

`mocon` isn't on npm yet, so it comes from a clone. `@opentelemetry/api` is a peer dependency, so you
install it yourself and pick the version.

Don't use `npm install github:tanvincible/mocon`. It looks right and fails: this repo is a workspace,
so npm installs the root as `mocon-workspace` with nothing built, and the import doesn't resolve. npm
has no way to install one subdirectory of a git repo.

Python is the same shape:

```sh
git clone https://github.com/tanvincible/mocon
pip install ./mocon/packages/python
```

The distribution is `pymocon` and the import is `mocon`. It isn't on PyPI yet either.

## Destination

mocon emits through the OpenTelemetry API and never the SDK. That's on purpose. It means your app
decides where telemetry goes, and mocon has no opinion and no config of its own.

It also means **nothing comes out until your app registers a tracer provider.** If there isn't one,
the OpenTelemetry API quietly does nothing. No spans, no error, no warning, exit code zero. This is
the number one reason an integration looks like it isn't working.

Already running OpenTelemetry? You're done, go to [your first trace](./quickstart.md).

If you're not, you've got two options.

**Set it up.** You'll need an SDK, an exporter, and somewhere for spans to land: Tempo, Jaeger,
Honeycomb, Datadog, whatever. That's real infrastructure work, so decide on it for its own reasons,
not because a library asked you to.

**Or skip it.** If your telemetry today is structured logs, send mocon's output to the logger you
already have. One line, no new infrastructure. See [Logging](./logs.md). You can
switch to real tracing later without touching your server code.

## Requirements

Node 20 or newer. TypeScript types are included, and plain JavaScript works fine.
