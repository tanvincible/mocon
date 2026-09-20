# Install

```sh
git clone https://github.com/tanvincible/mocon
cd mocon && npm install && npm run build && npm pack -w mocon && cd ..
npm install ./mocon/mocon-0.1.0.tgz @opentelemetry/api
```

Yes, that is four steps to install one package, and no, there is no shorter one until this is on
npm. `npm install github:tanvincible/mocon` looks right and installs the workspace root under the
name `mocon-workspace` with nothing built. Installing the package directory looks right and fails to
build, because npm does not install a path dependency's own build tools. Packing a tarball is what
publishing does, minus the registry.

`@opentelemetry/api` is a peer dependency, so you pick the version.

Python is shorter, because pip builds a path install properly:

```sh
git clone https://github.com/tanvincible/mocon
pip install ./mocon/packages/python
```

The distribution will be `pymocon` and the import is `mocon`. Not on PyPI yet either.

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
